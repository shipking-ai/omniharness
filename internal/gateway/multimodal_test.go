package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

// A text-only message must serialise exactly as it always did. If adding
// images changes the shape of ordinary requests, every existing call has
// silently changed.
func TestTextOnlyMessageWireFormatIsUnchanged(t *testing.T) {
	m := Message{Role: "user", Content: "hello"}
	got, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"role":"user","content":"hello"}`
	if string(got) != want {
		t.Fatalf("marshalled %s, want %s", got, want)
	}

	tool := Message{Role: "tool", Content: "result", ToolCallID: "c1", Name: "read_file"}
	got, err = json.Marshal(tool)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "images") {
		t.Errorf("a message with no images emitted an images field: %s", got)
	}
	if !strings.Contains(string(got), `"content":"result"`) {
		t.Errorf("tool content stopped being a plain string: %s", got)
	}
}

func TestImageMessageBecomesContentParts(t *testing.T) {
	m := Message{Role: "user", Content: "What is wrong with this render?", Images: []ImageRef{
		{MimeType: "image/png", Data: []byte{0x89, 'P', 'N', 'G'}, Source: "shot.png"},
	}}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var obj struct {
		Role    string `json:"role"`
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			ImageURL *struct {
				URL string `json:"url"`
			} `json:"image_url"`
		} `json:"content"`
		Images json.RawMessage `json:"images"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("content did not become an array: %v (%s)", err, raw)
	}
	if obj.Images != nil {
		t.Errorf("the internal images field leaked onto the wire: %s", raw)
	}
	if len(obj.Content) != 2 {
		t.Fatalf("got %d content parts, want text + image", len(obj.Content))
	}
	if obj.Content[0].Type != "text" || obj.Content[0].Text != "What is wrong with this render?" {
		t.Errorf("first part = %+v, want the text", obj.Content[0])
	}
	if obj.Content[1].Type != "image_url" || obj.Content[1].ImageURL == nil {
		t.Fatalf("second part = %+v, want an image_url", obj.Content[1])
	}
	url := obj.Content[1].ImageURL.URL
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Errorf("image url = %q, want a png data URL", url)
	}
	// The bytes must survive the round trip, or the model sees a broken image.
	if !strings.HasSuffix(url, "iVBORw==") && !strings.Contains(url, "iVBORw") {
		t.Errorf("image url %q does not carry the encoded bytes", url)
	}
}

// An image with no text still has to produce a valid parts array.
func TestImageOnlyMessageOmitsTheEmptyTextPart(t *testing.T) {
	m := Message{Role: "user", Images: []ImageRef{{MimeType: "image/png", Data: []byte("x")}}}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var obj struct {
		Content []map[string]any `json:"content"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	if len(obj.Content) != 1 || obj.Content[0]["type"] != "image_url" {
		t.Fatalf("content = %v, want a single image part", obj.Content)
	}
}

func TestDataURLFallsBackForUnknownMime(t *testing.T) {
	if got := (ImageRef{Data: []byte("x")}).DataURL(); !strings.HasPrefix(got, "data:application/octet-stream;base64,") {
		t.Errorf("DataURL with no mime = %q", got)
	}
}

// Responses come back with string content; some gateways echo a parts array.
// Both must decode, and neither may error.
func TestUnmarshalAcceptsStringAndPartsContent(t *testing.T) {
	var m Message
	if err := json.Unmarshal([]byte(`{"role":"assistant","content":"plain text"}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.Content != "plain text" {
		t.Errorf("Content = %q, want %q", m.Content, "plain text")
	}

	m = Message{}
	if err := json.Unmarshal([]byte(`{"role":"user","content":[{"type":"text","text":"a"},{"type":"image_url","image_url":{"url":"data:image/png;base64,eA=="}},{"type":"text","text":"b"}]}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.Content != "a\n[image]\nb" {
		t.Errorf("Content = %q, want the text parts joined with an image marker", m.Content)
	}

	// A null content must not be an error: some providers return it with
	// tool_calls and nothing else.
	m = Message{}
	if err := json.Unmarshal([]byte(`{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]}`), &m); err != nil {
		t.Fatalf("null content errored: %v", err)
	}
	if m.Content != "" || len(m.ToolCalls) != 1 {
		t.Errorf("null-content message decoded as %+v", m)
	}

	// A shape that is neither must be an error, not silently empty.
	m = Message{}
	if err := json.Unmarshal([]byte(`{"role":"user","content":42}`), &m); err == nil {
		t.Error("numeric content was accepted")
	}
}

// A full request round trip: the assistant/tool/user sequence an image
// observation actually produces.
func TestRequestRoundTrip(t *testing.T) {
	req := ChatRequest{Model: "p/m", Messages: []Message{
		{Role: "system", Content: "sys"},
		{Role: "assistant", Content: "", ToolCalls: []ToolCall{{ID: "c1", Type: "function"}}},
		{Role: "tool", ToolCallID: "c1", Name: "mcp:blender:get_viewport_screenshot", Content: "[image content, 4 bytes, image/png] saved to /tmp/a.png"},
		{Role: "user", Content: "Here is the viewport.", Images: []ImageRef{{MimeType: "image/png", Data: []byte{1, 2, 3}}}},
	}}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var back ChatRequest
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("a request with an image did not survive a round trip: %v", err)
	}
	if len(back.Messages) != 4 {
		t.Fatalf("got %d messages back, want 4", len(back.Messages))
	}
	if back.Messages[2].Content != "[image content, 4 bytes, image/png] saved to /tmp/a.png" {
		t.Errorf("the tool message changed: %q", back.Messages[2].Content)
	}
	if !strings.Contains(back.Messages[3].Content, "[image]") {
		t.Errorf("the image message decoded as %q", back.Messages[3].Content)
	}
}
