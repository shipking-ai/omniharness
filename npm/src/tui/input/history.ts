/**
 * Prompt history for the composer.
 *
 * A cursor over a newest-first list, with the one behaviour that makes recall
 * feel right: walking past the newest entry returns the composer to empty
 * rather than sticking on the last prompt.
 */

export class PromptHistory {
  private entries: string[] = [];
  /** -1 means "not browsing"; 0 is the newest entry. */
  private cursor = -1;

  public load(entries: readonly string[]): void {
    if (this.entries.length === 0) this.entries = [...entries];
  }

  public remember(prompt: string): void {
    const trimmed = prompt.trim();
    if (trimmed === '') return;
    this.entries = [trimmed, ...this.entries.filter((entry) => entry !== trimmed)].slice(0, 200);
    this.cursor = -1;
  }

  public reset(): void {
    this.cursor = -1;
  }

  public clear(): void {
    this.entries = [];
    this.cursor = -1;
  }

  public get browsing(): boolean {
    return this.cursor >= 0;
  }

  public get size(): number {
    return this.entries.length;
  }

  /** Step to an older prompt, or undefined when there is nothing older. */
  public older(): string | undefined {
    if (this.entries.length === 0) return undefined;
    this.cursor = this.cursor < 0 ? 0 : Math.min(this.cursor + 1, this.entries.length - 1);
    return this.entries[this.cursor];
  }

  /** Step to a newer prompt; past the newest this returns '' — an empty composer. */
  public newer(): string | undefined {
    if (this.cursor < 0) return undefined;
    this.cursor -= 1;
    return this.cursor < 0 ? '' : this.entries[this.cursor];
  }
}
