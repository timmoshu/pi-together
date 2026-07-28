// client/src/Markdown.tsx — GFM rendering for COMPLETED assistant messages only.
//
// Security posture (see README): react-markdown renders the mdast→React directly and does NOT enable
// raw HTML, so there is no HTML string and no need for dangerouslySetInnerHTML / DOMPurify. We add an
// explicit URL policy on top: only http/https/mailto links survive; anything else is dropped.
// Remote images are disabled by default. Streaming/model/tool/path text is rendered ESCAPED elsewhere
// (as plain text), never through this component.
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const v = href.trim();
  // allow relative/anchor links and safe schemes; reject javascript:, data:, vbscript:, etc.
  if (v.startsWith("#") || v.startsWith("/") || v.startsWith("./") || v.startsWith("../")) return v;
  return SAFE_SCHEME.test(v) ? v : undefined;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useMemo(() => nodeText(children).replace(/\n$/, ""), [children]);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="md-code-block">
      <button className="md-copy" type="button" onClick={() => void copy()} aria-label="Copy code to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
      <div className="md-pre-scroll">
        <pre>{children}</pre>
      </div>
    </div>
  );
}

const components: Components = {
  a({ href, children, ...rest }) {
    const safe = safeHref(href);
    if (!safe) return <span {...rest}>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
  // Remote images disabled by default: render alt text only.
  img({ alt }) {
    return <span className="md-img-placeholder">🖼 {alt || "image"}</span>;
  },
  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
  table({ children }) {
    return (
      <div className="md-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
