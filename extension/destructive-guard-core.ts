import { homedir } from "node:os";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";

export interface DestructiveGuardConfig { home: string; protectedAnchors: string[] }
const CONTROL = new Set([";", "&&", "||", "|", "\n"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "unlink"]);

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  const push = () => { if (word) words.push(word); word = ""; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && command[index + 1]) word += command[++index];
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "\\" && command[index + 1]) { word += command[++index]; continue; }
    if (/\s/.test(char)) { push(); if (char === "\n") words.push("\n"); continue; }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") { push(); words.push(pair); index++; continue; }
    if (char === ";" || char === "|") { push(); words.push(char); continue; }
    word += char;
  }
  push();
  return words;
}

function expandTarget(value: string, cwd: string, home: string): string | null {
  let expanded = value.replaceAll("${HOME}", home).replaceAll("$HOME", home);
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/")) expanded = `${home}/${expanded.slice(2)}`;
  if (/[`$][({]/.test(expanded) || expanded.includes("${") || expanded.includes("..*") || expanded.includes("\0")) return null;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return normalize(absolute).replace(/\/+$/, "") || "/";
}

function within(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function protectedTarget(target: string, config: DestructiveGuardConfig, cwd: string): boolean {
  if (target === "/" || target === config.home) return true;
  const homeRelative = relative(config.home, target);
  if (homeRelative && !homeRelative.startsWith("..") && !isAbsolute(homeRelative) && homeRelative.split(sep).length === 1) return true;
  const anchors = [...config.protectedAnchors, cwd];
  for (const anchor of anchors) {
    if (target === anchor) return true;
    const anchorRelative = relative(anchor, target);
    if (within(anchor, target) && anchorRelative.split(sep)[0] === ".git") return true;
    if (within(anchor, target) && anchorRelative.split(sep).length === 1 && /[*?{[]/.test(anchorRelative)) return true;
  }
  return false;
}

export function destructiveCommandReason(command: string, cwd: string, configValue: DestructiveGuardConfig): string | null {
  const config = { home: resolve(configValue.home || homedir()), protectedAnchors: configValue.protectedAnchors.map((path) => resolve(path)) };
  const words = shellWords(command);
  for (let index = 0; index < words.length; index++) {
    const executable = basename(words[index]!);
    if (DESTRUCTIVE.has(executable)) {
      const end = words.findIndex((word, at) => at > index && CONTROL.has(word));
      const segment = words.slice(index + 1, end < 0 ? words.length : end);
      if (segment.some((word) => word.includes("$(`") || word.includes("$(") || word.includes("`"))) return "Blocked ambiguous destructive command targeting protected host paths";
      for (const value of segment.filter((word) => word !== "--" && !word.startsWith("-"))) {
        const target = expandTarget(value, cwd, config.home);
        if (!target || protectedTarget(target, config, cwd)) return "Blocked destructive command targeting a protected directory anchor";
      }
    }
    if (executable === "find") {
      const end = words.findIndex((word, at) => at > index && CONTROL.has(word));
      const segment = words.slice(index + 1, end < 0 ? words.length : end);
      if (segment.includes("-delete")) {
        const value = segment.find((word) => !word.startsWith("-"));
        const target = value ? expandTarget(value, cwd, config.home) : null;
        if (!target || protectedTarget(target, config, cwd)) return "Blocked broad find deletion at a protected directory anchor";
      }
    }
    if (executable === "git" && words[index + 1] === "clean") {
      const flags = words.slice(index + 2).filter((word) => word.startsWith("-")).join("");
      if (flags.includes("f") && flags.includes("d")) return "Blocked recursive Git clean in a managed Pi session";
    }
  }
  return null;
}
