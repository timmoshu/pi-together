interface KeyboardLike {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export function trapFocus(event: KeyboardLike, container: HTMLElement | null): void {
  if (event.key !== "Tab") return;
  const controls = [...(container?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  ) ?? [])].filter((control) => !control.closest('[inert]'));
  if (!controls.length) return;
  const index = controls.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey
    ? controls[(index <= 0 ? controls.length : index) - 1]
    : controls[(index + 1) % controls.length];
  event.preventDefault();
  next?.focus();
}
