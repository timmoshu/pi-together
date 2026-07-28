import { useEffect, useState } from "react";

const DESKTOP = "(min-width: 820px)";
export function useIsDesktop() {
  const [d, setD] = useState(() => (typeof matchMedia === "function" ? matchMedia(DESKTOP).matches : true));
  useEffect(() => {
    const mq = matchMedia(DESKTOP);
    const on = () => setD(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return d;
}

/** iOS keeps its home-indicator safe inset while the software keyboard covers that area. */
export function useSoftwareKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const focused = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      const obscuredHeight = window.innerHeight - viewport.height - viewport.offsetTop;
      setOpen(focused && window.innerWidth < 820 && obscuredHeight > 120);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
    };
  }, []);
  return open;
}
