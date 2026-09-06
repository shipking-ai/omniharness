package gateway

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// ImageRef is an image attached to a message. OmniRoute speaks the
// OpenAI-compatible dialect, where an image is carried inline as a data URL
// inside a content part; there is no upload endpoint to reference instead.
type ImageRef struct {
	// MimeType is the image's media type, e.g. "image/png".
	MimeType string `json:"mimeType"`
	// Data is the raw image bytes. They are base64-encoded on the wire.
	Data []byte `json:"-"`
	// Source is where the image came from, for logging and for the text
	// fallback when a model cannot accept images. Never sent to the model as
	// part of the image itself.
	Source string `json:"source,omitempty"`
}

// DataURL renders the image as the inline data URL the wire format expects.
func (i ImageRef) DataURL() string {
	mime := strings.TrimSpace(i.MimeType)
	if mime == "" {
		mime = "application/octet-stream"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(i.Data)
}

// contentPart is one element of a multimodal content array.
type contentPart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	ImageURL *struct {
		URL string `json:"url"`
	} `json:"image_url,omitempty"`
}

// MarshalJSON writes a message in OpenAI wire format. With no images the
// content stays a plain string, byte for byte what this client always sent —
// a text-only request must not change shape because a feature it does not use
// exists. With images it becomes the content-parts array.
func (m Message) MarshalJSON() ([]byte, error) {
	type plain Message // avoids recursing into this method
	if len(m.Images) == 0 {
		return json.Marshal(plain(m))
	}
	parts := make([]contentPart, 0, len(m.Images)+1)
	if m.Content != "" {
		parts = append(parts, contentPart{Type: "text", Text: m.Content})
	}
	for _, img := range m.Images {
		p := contentPart{Type: "image_url"}
		p.ImageURL = &struct {
			URL string `json:"url"`
		}{URL: img.DataURL()}
		parts = append(parts, p)
	}
	// Marshal the rest of the message normally, then replace content.
	raw, err := json.Marshal(plain(m))
	if err != nil {
		return nil, err
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(parts)
	if err != nil {
		return nil, err
	}
	obj["content"] = encoded
	delete(obj, "images")
	return json.Marshal(obj)
}

// UnmarshalJSON reads a message whose content may be a string (every ordinary
// response) or a content-parts array (some gateways echo the request back that
// way). Text parts are concatenated; image parts are noted but not decoded,
// since nothing in the harness reads an image back out of a response.
func (m *Message) UnmarshalJSON(data []byte) error {
	type plain Message
	var raw struct {
		plain
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*m = Message(raw.plain)
	m.Content = ""
	if len(raw.Content) == 0 || string(raw.Content) == "null" {
		return nil
	}
	var s string
	if err := json.Unmarshal(raw.Content, &s); err == nil {
		m.Content = s
		return nil
	}
	var parts []contentPart
	if err := json.Unmarshal(raw.Content, &parts); err != nil {
		return fmt.Errorf("message content is neither a string nor content parts: %w", err)
	}
	var b strings.Builder
	for _, p := range parts {
		switch {
		case p.Type == "text" || p.Text != "":
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(p.Text)
		case p.ImageURL != nil:
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString("[image]")
		}
	}
	m.Content = b.String()
	return nil
}
