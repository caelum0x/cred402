import type { StepLog } from "../agents/economy.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function banner(title: string): void {
  const bar = "─".repeat(Math.max(8, title.length + 4));
  console.log(`\n${CYAN}┌${bar}┐${RESET}`);
  console.log(`${CYAN}│ ${BOLD}${title}${RESET}${CYAN} │${RESET}`);
  console.log(`${CYAN}└${bar}┘${RESET}`);
}

let sceneNo = 0;
export function scene(step: StepLog): void {
  sceneNo += 1;
  console.log(`\n${BOLD}${GREEN}● Scene ${sceneNo} — ${step.scene}${RESET}`);
  for (const line of step.lines) {
    const colored = line
      .replace(/\[critical\]/g, `${RED}[critical]${RESET}`)
      .replace(/\[warn\]/g, `${YELLOW}[warn]${RESET}`)
      .replace(/\[info\]/g, `${DIM}[info]${RESET}`);
    console.log(`  ${colored}`);
  }
}

export function note(msg: string): void {
  console.log(`${DIM}  ${msg}${RESET}`);
}
