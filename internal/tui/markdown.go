package tui

import (
	"regexp"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// The answer bubbles used to print a reply exactly as the model wrote it, so a
// heading arrived as "## Plan", every inline command in backticks and the
// closing line wrapped in "**". This is the small subset replies actually use:
// headings, bold, inline code, bullets and fences. Anything else passes through.
//
// Every segment is styled explicitly, plain text included. The enclosing block
// sets a foreground, but the reset at the end of a styled span would cancel it
// for the rest of the line.

var (
	mdText    = lipgloss.NewStyle().Foreground(lipgloss.Color("#DCE6F2"))
	mdBold    = mdText.Bold(true)
	mdHeading = lipgloss.NewStyle().Foreground(pAccent).Bold(true)
	mdCode    = lipgloss.NewStyle().Foreground(lipgloss.Color("#7DD3C0"))
	mdRule    = lipgloss.NewStyle().Foreground(pMuted)

	mdFence  = regexp.MustCompile("^\\s*```")
	mdHead   = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	mdBullet = regexp.MustCompile(`^(\s*)[-*+]\s+(.*)$`)
	mdInline = regexp.MustCompile("\\*\\*([^*]+)\\*\\*|`([^`]+)`")
)

// renderMarkdown styles a reply for the terminal.
func renderMarkdown(src string) string {
	lines := strings.Split(strings.ReplaceAll(src, "\r", ""), "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	for _, line := range lines {
		if mdFence.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			out = append(out, mdRule.Render("│ ")+mdCode.Render(line))
			continue
		}
		if h := mdHead.FindStringSubmatch(line); h != nil {
			out = append(out, mdHeading.Render(stripInline(h[2])))
			continue
		}
		if b := mdBullet.FindStringSubmatch(line); b != nil {
			out = append(out, mdText.Render(b[1]+"• ")+renderInline(b[2]))
			continue
		}
		out = append(out, renderInline(line))
	}
	return strings.Join(out, "\n")
}

// renderInline styles **bold** and `code` spans and drops their markers.
func renderInline(line string) string {
	var b strings.Builder
	last := 0
	for _, loc := range mdInline.FindAllStringSubmatchIndex(line, -1) {
		if loc[0] > last {
			b.WriteString(mdText.Render(line[last:loc[0]]))
		}
		if loc[2] >= 0 {
			b.WriteString(mdBold.Render(line[loc[2]:loc[3]]))
		} else {
			b.WriteString(mdCode.Render(line[loc[4]:loc[5]]))
		}
		last = loc[1]
	}
	if last < len(line) {
		b.WriteString(mdText.Render(line[last:]))
	}
	return b.String()
}

// stripInline drops inline markers without styling, for text that already
// carries a style of its own.
func stripInline(line string) string {
	return mdInline.ReplaceAllStringFunc(line, func(span string) string {
		return strings.Trim(span, "*`")
	})
}
