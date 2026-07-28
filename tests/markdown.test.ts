import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../client/src/Markdown.js";

describe("Markdown code blocks", () => {
  it("renders wrapped code in a copyable block", () => {
    const command = "npm install -g --ignore-scripts /tmp/pi-together-0.1.0.tgz && hash -r && pi-together onboard";
    const html = renderToStaticMarkup(Markdown({ text: `\`\`\`sh\n${command}\n\`\`\`` }));

    expect(html).toContain('class="md-code-block"');
    expect(html).toContain('class="md-copy"');
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html).toContain(command.replaceAll("&", "&amp;"));
  });
});
