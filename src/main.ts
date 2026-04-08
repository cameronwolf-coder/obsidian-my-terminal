import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TFile,
	WorkspaceLeaf,
	addIcon,
	setIcon,
} from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TerminalSettings {
	stripFormattingOnPaste: boolean;
	rightClickPaste: boolean;
	copyOnSelect: boolean;
	autoCdOnOpen: boolean;
	followActiveNote: boolean;
	composeBox: boolean;
	fontSize: number;
	fontFamily: string;
	scrollback: number;
	cursorStyle: "block" | "underline" | "bar";
	cursorBlink: boolean;
	bellStyle: "none" | "visual";
	shell: string;
	startupCommand: string;
}

interface WikiEntry {
	name: string;
	folder: string;
	isFile: boolean;
	mtime: number;
}

interface Bookmark {
	id: number;
	marker: import("@xterm/xterm").IMarker;
	decoration: import("@xterm/xterm").IDecoration | null;
	label: string;
	timestamp: number;
	pipEl: HTMLElement;
}

type LayoutMode = "single" | "split-h" | "split-v" | "grid";

interface CaptureOption {
	label: string;
	action: "daily" | "current" | "new";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const VIEW_TYPE = "vin-terminal-view";

// Wolf terminal icon: terminal window with pointed wolf ears
const WOLF_ICON_ID = "wolf-terminal";
// Obsidian addIcon uses a 0 0 100 100 viewBox — coordinates must be in that space.
const WOLF_ICON_SVG =
	// Terminal body
	'<rect x="5" y="28" width="90" height="62" rx="6" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>' +
	// Left wolf ear (triangle sitting on top-left of rect)
	'<path d="M8 28L16 4L40 28" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
	// Right wolf ear (triangle sitting on top-right of rect)
	'<path d="M60 28L84 4L92 28" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
	// > prompt
	'<path d="M18 50l20 9-20 9" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
	// _ cursor
	'<line x1="44" y1="66" x2="78" y2="66" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>';

const DEFAULT_SETTINGS: TerminalSettings = {
	stripFormattingOnPaste: true,
	rightClickPaste: true,
	copyOnSelect: false,
	autoCdOnOpen: true,
	followActiveNote: false,
	composeBox: false,
	fontSize: 13.5,
	fontFamily: "'SF Mono', 'IBM Plex Mono', ui-monospace, 'Cascadia Code', monospace",
	scrollback: 5000,
	cursorStyle: "block",
	cursorBlink: true,
	bellStyle: "none",
	shell: "/bin/zsh",
	startupCommand: "",
};

let pluginSettings: TerminalSettings = { ...DEFAULT_SETTINGS };
let ptyHelperPath = "";

const PTY_HELPER_SRC = [
	'"""PTY helper for vin-terminal. Wraps zsh in a real PTY with resize support."""',
	"import os, select, signal, struct, fcntl, termios, pty",
	"",
	"def main():",
	'    cols = int(os.environ.get("VIN_TERM_COLS", "80"))',
	'    rows = int(os.environ.get("VIN_TERM_ROWS", "24"))',
	"    master, slave = pty.openpty()",
	"    fcntl.ioctl(master, termios.TIOCSWINSZ,",
	'                struct.pack("HHHH", rows, cols, 0, 0))',
	"    pid = os.fork()",
	"    if pid == 0:",
	"        os.close(master)",
	"        os.setsid()",
	"        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)",
	"        os.dup2(slave, 0)",
	"        os.dup2(slave, 1)",
	"        os.dup2(slave, 2)",
	"        if slave > 2:",
	"            os.close(slave)",
	'        shell = os.environ.get("VIN_SHELL", "/bin/zsh")',
	'        os.execvp(shell, [shell, "-i", "-l"])',
	"    os.close(slave)",
	"    def resize(c, r):",
	"        fcntl.ioctl(master, termios.TIOCSWINSZ,",
	'                    struct.pack("HHHH", r, c, 0, 0))',
	"        os.kill(pid, signal.SIGWINCH)",
	'    buf = b""',
	'    SEQ_START = b"\\x1b]R;"',
	'    SEQ_END = b"\\x07"',
	"    try:",
	"        while True:",
	"            rlist, _, _ = select.select([0, master], [], [])",
	"            if 0 in rlist:",
	"                data = os.read(0, 4096)",
	"                if not data:",
	"                    break",
	"                buf += data",
	"                while SEQ_START in buf:",
	"                    idx = buf.index(SEQ_START)",
	"                    end = buf.find(SEQ_END, idx)",
	"                    if end < 0:",
	"                        if idx > 0:",
	"                            os.write(master, buf[:idx])",
	"                        buf = buf[idx:]",
	"                        break",
	"                    if idx > 0:",
	"                        os.write(master, buf[:idx])",
	"                    seq = buf[idx + len(SEQ_START):end]",
	"                    buf = buf[end + 1:]",
	"                    try:",
	"                        parts = seq.split(b\";\")",
	"                        if len(parts) == 2:",
	"                            resize(int(parts[0]), int(parts[1]))",
	"                    except (ValueError, IndexError):",
	"                        pass",
	"                else:",
	"                    if buf:",
	"                        os.write(master, buf)",
	'                        buf = b""',
	"            if master in rlist:",
	"                try:",
	"                    data = os.read(master, 4096)",
	"                    if not data:",
	"                        break",
	"                    os.write(1, data)",
	"                except OSError:",
	"                    break",
	"    except Exception:",
	"        pass",
	"    try:",
	"        os.kill(pid, signal.SIGTERM)",
	"    except ProcessLookupError:",
	"        pass",
	"    try:",
	"        os.waitpid(pid, 0)",
	"    except ChildProcessError:",
	"        pass",
	"",
	'if __name__ == "__main__":',
	"    main()",
	"",
].join("\n");

// ─── Utilities ───────────────────────────────────────────────────────────────

function stripAnsiRaw(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[^[]/g, "")
		.replace(/\u00a0/g, " ")
		.replace(/\r\n/g, "\n");
}

function getObsidianTheme() {
	const s = getComputedStyle(document.body);
	const get = (v: string) => s.getPropertyValue(v).trim();
	const isDark = document.body.classList.contains("theme-dark");
	const bg = get("--background-primary") || (isDark ? "#1e1e1e" : "#ffffff");
	const fg = get("--text-normal") || (isDark ? "#dcddde" : "#1a1a1a");
	const muted = get("--text-muted") || (isDark ? "#999" : "#666");
	const ansi = isDark
		? {
				black: "#1a1a2e", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
				blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
				brightBlack: "#5c6370", brightRed: "#e88388", brightGreen: "#a9d18e",
				brightYellow: "#ebd09c", brightBlue: "#7ec8e3", brightMagenta: "#d19de0",
				brightCyan: "#73cdd6", brightWhite: "#f0f0f0",
			}
		: {
				black: "#383a42", red: "#d73a49", green: "#22863a", yellow: "#b08800",
				blue: "#0366d6", magenta: "#6f42c1", cyan: "#0598bc", white: "#6a737d",
				brightBlack: "#959da5", brightRed: "#cb2431", brightGreen: "#28a745",
				brightYellow: "#dbab09", brightBlue: "#2188ff", brightMagenta: "#8a63d2",
				brightCyan: "#3192aa", brightWhite: "#24292e",
			};
	return {
		background: bg, foreground: fg, cursor: muted, cursorAccent: bg,
		selectionBackground: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)",
		selectionForeground: isDark ? "#f0f0f0" : "#1a1a1a",
		...ansi,
	};
}

/** Check python3 availability using spawnSync with fixed args (no user input). */
function python3Available(): boolean {
	const { spawnSync } = require("child_process");
	return spawnSync("which", ["python3"], { encoding: "utf8" }).status === 0;
}

// ─── WikiLinkAutocomplete ─────────────────────────────────────────────────────

class WikiLinkAutocomplete {
	private _active = false;
	get active(): boolean { return this._active; }
	private query = "";
	private results: WikiEntry[] = [];
	private selectedIndex = 0;
	private lastCharWasBracket = false;
	private dropdownEl: HTMLElement | null = null;
	private filterTimer: ReturnType<typeof setTimeout> | null = null;
	private previewEl: HTMLElement | null = null;
	private resizeDisposable: import("@xterm/xterm").IDisposable | null = null;

	constructor(
		private readonly app: App,
		private readonly terminal: Terminal,
		private readonly writeToShell: (data: string) => void,
		private readonly containerEl: HTMLElement
	) {
		this.terminal.attachCustomKeyEventHandler((e) => {
			if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
				e.preventDefault();
				this.writeToShell("\n");
				return false;
			}
			if (!this.active) return true;
			if (e.type !== "keydown") return false;
			switch (e.key) {
				case "ArrowUp":
					e.preventDefault();
					this.selectedIndex = Math.max(0, this.selectedIndex - 1);
					this.renderDropdown();
					return false;
				case "ArrowDown":
					e.preventDefault();
					this.selectedIndex = Math.min(this.results.length - 1, this.selectedIndex + 1);
					this.renderDropdown();
					return false;
				case "Enter":
				case "Tab":
					e.preventDefault();
					this.accept();
					return false;
				case "Escape":
					e.preventDefault();
					this.dismiss();
					return false;
				case "Backspace":
					e.preventDefault();
					if (this.query.length > 0) {
						this.query = this.query.slice(0, -1);
						this.filterResults();
					} else {
						this.dismiss();
					}
					return false;
				default:
					if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
						e.preventDefault();
						this.query += e.key;
						this.filterResults();
						return false;
					}
					if (e.metaKey || e.ctrlKey) return true;
					return false;
			}
		});

		this.resizeDisposable = this.terminal.onResize(() => {
			if (this.active && this.dropdownEl) this.positionDropdown();
		});
	}

	/** Called for every onData event. Detects [[ by tracking consecutive brackets. */
	handleData(data: string): void {
		if (this.active) return;
		if (data.length > 1) {
			if (data.includes("[[")) this.activate();
			this.lastCharWasBracket = data.endsWith("[");
			return;
		}
		if (data === "[") {
			if (this.lastCharWasBracket) {
				this.lastCharWasBracket = false;
				this.activate();
			} else {
				this.lastCharWasBracket = true;
			}
		} else {
			this.lastCharWasBracket = false;
		}
	}

	private activate(): void {
		this._active = true;
		this.query = "";
		this.results = [];
		this.selectedIndex = 0;
		this.filterResults();
	}

	private accept(): void {
		if (this.results.length > 0 && this.selectedIndex < this.results.length) {
			this.writeToShell(`${this.results[this.selectedIndex].name}]]`);
		} else if (this.query.length > 0) {
			this.writeToShell(`${this.query}]]`);
		} else {
			this.writeToShell("]]");
		}
		this.deactivate();
	}

	private dismiss(): void {
		if (this.query.length > 0) this.writeToShell(this.query);
		this.deactivate();
	}

	private deactivate(): void {
		this._active = false;
		this.query = "";
		this.results = [];
		this.selectedIndex = 0;
		this.removeDropdown();
	}

	private getAllEntries(): WikiEntry[] {
		const entries: WikiEntry[] = [];
		const seen = new Set<string>();
		for (const f of this.app.vault.getFiles()) {
			entries.push({ name: f.basename, folder: f.parent?.path || "", isFile: true, mtime: f.stat.mtime });
			seen.add(f.basename.toLowerCase());
		}
		const unresolved = (this.app.metadataCache as any).unresolvedLinks as
			| Record<string, Record<string, number>> | undefined;
		if (unresolved) {
			for (const src of Object.values(unresolved)) {
				for (const target of Object.keys(src)) {
					const key = target.toLowerCase();
					if (!seen.has(key)) {
						seen.add(key);
						entries.push({ name: target, folder: "", isFile: false, mtime: 0 });
					}
				}
			}
		}
		return entries;
	}

	private filterResults(): void {
		if (this.filterTimer) clearTimeout(this.filterTimer);
		this.filterTimer = setTimeout(() => {
			const q = this.query.toLowerCase();
			const all = this.getAllEntries();
			if (q.length === 0) {
				this.results = all.sort((a, b) => b.mtime - a.mtime).slice(0, 10);
			} else {
				const prefix: WikiEntry[] = [];
				const contains: WikiEntry[] = [];
				for (const e of all) {
					const n = e.name.toLowerCase();
					if (n.startsWith(q)) prefix.push(e);
					else if (n.includes(q)) contains.push(e);
				}
				this.results = [...prefix, ...contains].slice(0, 10);
			}
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.results.length - 1));
			this.renderDropdown();
		}, 16);
	}

	private renderDropdown(): void {
		if (!this.dropdownEl) {
			this.dropdownEl = document.createElement("div");
			this.dropdownEl.className = "vin-wikilink-dropdown";
			this.containerEl.appendChild(this.dropdownEl);
		}
		this.positionDropdown();

		// Build dropdown using safe DOM methods (no innerHTML with user content)
		this.dropdownEl.empty();

		const header = this.dropdownEl.createDiv({ cls: "vin-wikilink-header" });
		header.textContent = `[[${this.query}`;

		if (this.results.length === 0) {
			this.dropdownEl.createDiv({ cls: "vin-wikilink-empty", text: "No matches" });
		} else {
			const list = this.dropdownEl.createDiv({ cls: "vin-wikilink-list" });
			this.results.forEach((entry, i) => {
				const item = list.createDiv({
					cls: [
						"vin-wikilink-item",
						i === this.selectedIndex ? "is-selected" : "",
						entry.isFile ? "" : "is-unresolved",
					].filter(Boolean).join(" "),
				});
				item.dataset.index = String(i);
				item.createSpan({ cls: "vin-wikilink-name", text: entry.name });
				if (entry.isFile && entry.folder && entry.folder !== "/") {
					item.createSpan({ cls: "vin-wikilink-path", text: entry.folder });
				} else if (!entry.isFile) {
					item.createSpan({ cls: "vin-wikilink-path", text: "no file yet" });
				}
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.selectedIndex = parseInt(item.dataset.index || "0", 10);
					this.accept();
				});
			});
		}

		this.renderPreview();
	}

	private positionDropdown(): void {
		if (!this.dropdownEl) return;
		const buf = this.terminal.buffer.active;
		const screen = this.containerEl.querySelector(".xterm-screen");
		if (!screen) return;
		const sr = screen.getBoundingClientRect();
		const cr = this.containerEl.getBoundingClientRect();
		const cellW = sr.width / this.terminal.cols;
		const cellH = sr.height / this.terminal.rows;
		const ox = sr.left - cr.left;
		const oy = sr.top - cr.top;
		const dropW = 300;
		const dropH = 220;
		let left = ox + buf.cursorX * cellW;
		if (left + dropW > cr.width) left = Math.max(4, cr.width - dropW - 4);
		const cursorBottom = oy + (buf.cursorY + 1) * cellH;
		if (cr.height - cursorBottom > dropH || buf.cursorY < this.terminal.rows / 2) {
			this.dropdownEl.style.top = `${cursorBottom}px`;
			this.dropdownEl.style.bottom = "";
		} else {
			this.dropdownEl.style.bottom = `${cr.height - (oy + buf.cursorY * cellH)}px`;
			this.dropdownEl.style.top = "";
		}
		this.dropdownEl.style.left = `${left}px`;
	}

	private removeDropdown(): void {
		this.removePreview();
		if (this.dropdownEl) { this.dropdownEl.remove(); this.dropdownEl = null; }
	}

	private async renderPreview(): Promise<void> {
		const entry = this.results[this.selectedIndex];
		if (!entry || !entry.isFile) { this.removePreview(); return; }
		if (!this.previewEl) {
			this.previewEl = document.createElement("div");
			this.previewEl.className = "vin-wikilink-preview";
			this.containerEl.appendChild(this.previewEl);
		}
		this.positionPreview();

		const filePath = entry.folder ? `${entry.folder}/${entry.name}.md` : `${entry.name}.md`;
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			this.previewEl.empty();
			this.previewEl.createDiv({ cls: "vin-preview-empty", text: "File not found" });
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const preview = content.split("\n").slice(0, 10).join("\n");
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = cache?.tags?.map((t) => t.tag) ?? [];
		const frontmatterTags = (cache?.frontmatter?.tags as string[]) ?? [];
		const allTags = [...new Set([...tags, ...frontmatterTags])];
		const resolved = (this.app.metadataCache as any).resolvedLinks ?? {};
		let backlinkCount = 0;
		for (const src of Object.keys(resolved)) {
			if (resolved[src]?.[file.path]) backlinkCount++;
		}
		const dateStr = new Date(file.stat.mtime).toLocaleDateString("en-US", {
			month: "short", day: "numeric", year: "numeric",
		});

		// Build preview using safe DOM methods
		this.previewEl.empty();
		const meta = this.previewEl.createDiv({ cls: "vin-preview-meta" });
		meta.createSpan({ cls: "vin-preview-date", text: dateStr });
		meta.createSpan({ cls: "vin-preview-backlinks", text: `${backlinkCount} backlink${backlinkCount !== 1 ? "s" : ""}` });
		if (allTags.length > 0) {
			const tagsEl = this.previewEl.createDiv({ cls: "vin-preview-tags" });
			for (const t of allTags) tagsEl.createSpan({ cls: "vin-preview-tag", text: String(t) });
		}
		this.previewEl.createDiv({ cls: "vin-preview-content", text: preview });
	}

	private positionPreview(): void {
		if (!this.previewEl || !this.dropdownEl) return;
		const dropRect = this.dropdownEl.getBoundingClientRect();
		const containerRect = this.containerEl.getBoundingClientRect();
		const previewWidth = 280;
		const rightSpace = containerRect.right - dropRect.right;
		if (rightSpace >= previewWidth) {
			this.previewEl.style.left = `${dropRect.right - containerRect.left + 4}px`;
		} else {
			this.previewEl.style.left = `${dropRect.left - containerRect.left - previewWidth - 4}px`;
		}
		this.previewEl.style.top = this.dropdownEl.style.top;
		this.previewEl.style.bottom = this.dropdownEl.style.bottom;
		this.previewEl.style.width = `${previewWidth}px`;
	}

	private removePreview(): void {
		if (this.previewEl) { this.previewEl.remove(); this.previewEl = null; }
	}

	destroy(): void {
		if (this.filterTimer) clearTimeout(this.filterTimer);
		this.removePreview();
		this.removeDropdown();
		this.resizeDisposable?.dispose();
	}
}

// ─── BookmarkManager ──────────────────────────────────────────────────────────

class BookmarkManager {
	private bookmarks: Bookmark[] = [];
	private nextId = 1;
	private updateTimer: ReturnType<typeof setTimeout> | null = null;
	private disposables: import("@xterm/xterm").IDisposable[] = [];
	private readonly stripEl: HTMLElement;

	constructor(
		private readonly terminal: Terminal,
		private readonly containerEl: HTMLElement
	) {
		this.stripEl = document.createElement("div");
		this.stripEl.className = "vin-bookmark-strip";
		this.containerEl.appendChild(this.stripEl);
		const debouncedUpdate = () => {
			if (this.updateTimer) clearTimeout(this.updateTimer);
			this.updateTimer = setTimeout(() => this.updateStrip(), 50);
		};
		this.disposables.push(this.terminal.onScroll(debouncedUpdate));
		this.disposables.push(this.terminal.onLineFeed(debouncedUpdate));
		this.disposables.push(this.terminal.onResize(debouncedUpdate));
	}

	addBookmark(label?: string): void {
		const buf = this.terminal.buffer.active;
		const viewportTop = buf.viewportY;
		const cursorLine = buf.baseY + buf.cursorY;
		const line = viewportTop < buf.baseY ? viewportTop : cursorLine;
		const marker = this.terminal.registerMarker(line - cursorLine);
		if (!marker) return;
		const id = this.nextId++;
		const bookmarkLabel = label || `#${id}`;
		let decoration: import("@xterm/xterm").IDecoration | null = null;
		try {
			decoration = this.terminal.registerDecoration({ marker, anchor: "left" }) ?? null;
			decoration?.onRender((el) => {
				el.classList.add("vin-bookmark-gutter");
				el.title = bookmarkLabel;
				el.addEventListener("click", () => this.jumpTo(bookmark));
			});
		} catch {}
		const pipEl = document.createElement("div");
		pipEl.className = "vin-bookmark-pip";
		pipEl.title = bookmarkLabel;
		pipEl.addEventListener("click", () => this.jumpTo(bookmark));
		this.stripEl.appendChild(pipEl);
		const bookmark: Bookmark = { id, marker, decoration, label: bookmarkLabel, timestamp: Date.now(), pipEl };
		this.bookmarks.push(bookmark);
		marker.onDispose(() => this.removeBookmark(bookmark));
		this.updateStrip();
	}

	jumpTo(bookmark: Bookmark): void {
		this.terminal.scrollToLine(bookmark.marker.line);
		bookmark.pipEl.addClass("is-active");
		setTimeout(() => bookmark.pipEl?.removeClass("is-active"), 600);
	}

	jumpNext(): void {
		if (!this.bookmarks.length) return;
		const sorted = [...this.bookmarks].sort((a, b) => a.marker.line - b.marker.line);
		const vy = this.terminal.buffer.active.viewportY;
		this.jumpTo(sorted.find((b) => b.marker.line > vy + 1) ?? sorted[0]);
	}

	jumpPrev(): void {
		if (!this.bookmarks.length) return;
		const sorted = [...this.bookmarks].sort((a, b) => a.marker.line - b.marker.line);
		const vy = this.terminal.buffer.active.viewportY;
		this.jumpTo(sorted.slice().reverse().find((b) => b.marker.line < vy) ?? sorted[sorted.length - 1]);
	}

	clearAll(): void {
		for (const b of [...this.bookmarks]) this.removeBookmark(b);
	}

	private removeBookmark(bookmark: Bookmark): void {
		const idx = this.bookmarks.indexOf(bookmark);
		if (idx === -1) return;
		this.bookmarks.splice(idx, 1);
		bookmark.pipEl?.remove();
		try { bookmark.decoration?.dispose(); } catch {}
		try { bookmark.marker?.dispose(); } catch {}
	}

	private updateStrip(): void {
		const total = this.terminal.buffer.active.length;
		if (!total) return;
		for (const b of this.bookmarks) {
			if (b.pipEl) b.pipEl.style.top = `${(b.marker.line / total) * 100}%`;
		}
	}

	destroy(): void {
		if (this.updateTimer) clearTimeout(this.updateTimer);
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
		this.clearAll();
		this.stripEl.remove();
	}
}

// ─── TerminalSession ──────────────────────────────────────────────────────────

class TerminalSession {
	readonly id: number;
	name: string;
	readonly containerEl: HTMLElement;
	readonly terminal: Terminal;
	readonly process: ReturnType<typeof import("child_process").spawn>;
	hasActivity = false;
	readonly autocomplete: WikiLinkAutocomplete | null;

	private readonly fitAddon: FitAddon;
	private textareaEl: HTMLTextAreaElement | null = null;
	private bookmarkManager: BookmarkManager | null = null;
	private _activityCallback: ((s: TerminalSession) => void) | null = null;
	private dropZoneEl: HTMLElement | null = null;
	private dropBadgeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(parent: HTMLElement, id: number, cwd: string, app: App) {
		this.id = id;
		this.name = `zsh ${id}`;
		this.containerEl = parent.createDiv({ cls: "vin-terminal-session" });
		this.terminal = new Terminal({
			cursorBlink: pluginSettings.cursorBlink,
			cursorStyle: pluginSettings.cursorStyle,
			fontSize: pluginSettings.fontSize,
			fontFamily: pluginSettings.fontFamily,
			scrollback: pluginSettings.scrollback,
			lineHeight: 1.4, letterSpacing: 0.3,
			fontWeight: "400", fontWeightBold: "600",
			theme: getObsidianTheme(), allowProposedApi: true,
		});
		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.open(this.containerEl);
		this.textareaEl = this.containerEl.querySelector(".xterm-helper-textarea");
		this.terminal.onBell(() => {
			if (pluginSettings.bellStyle !== "visual") return;
			this.containerEl.classList.add("vin-bell-flash");
			setTimeout(() => this.containerEl.classList.remove("vin-bell-flash"), 150);
		});

		const { spawn } = require("child_process");
		const { CLAUDECODE, ...cleanEnv } = process.env;
		this.process = spawn("python3", [ptyHelperPath], {
			cwd,
			env: { ...cleanEnv, TERM: "xterm-256color", LANG: "en_US.UTF-8", VIN_TERM_COLS: "80", VIN_TERM_ROWS: "24", VIN_SHELL: pluginSettings.shell },
		});

		this.autocomplete = new WikiLinkAutocomplete(
			app, this.terminal,
			(data) => this.process.stdin?.write(data),
			this.containerEl
		);
		this.bookmarkManager = new BookmarkManager(this.terminal, this.containerEl);

		this.terminal.onData((data) => {
			this.autocomplete?.handleData(data);
			this.process.stdin?.write(data);
		});
		this.process.stdout?.on("data", (data: Buffer) => {
			this.terminal.write(data);
			if (this._activityCallback) this._activityCallback(this);
		});
		this.process.stderr?.on("data", (data: Buffer) => { this.terminal.write(data); });
		this.process.on("exit", () => { this.terminal.write("\r\n[Process exited]\r\n"); });
		this.terminal.onResize(({ cols, rows }) => {
			this.process.stdin?.write(`\x1B]R;${cols};${rows}\x07`);
		});

		setTimeout(() => this.fit(), 50);

		if (pluginSettings.startupCommand.trim()) {
			setTimeout(() => { this.process.stdin?.write(pluginSettings.startupCommand.trim() + "\n"); }, 800);
		}

		if (this.textareaEl) {
			this.textareaEl.addEventListener("paste", (e) => {
				if (!pluginSettings.stripFormattingOnPaste) return;
				const raw = e.clipboardData?.getData("text/plain") ?? "";
				if (!raw) return;
				e.preventDefault();
				e.stopPropagation();
				this.terminal.input(stripAnsiRaw(raw), true);
			});
		}

		this.containerEl.addEventListener("contextmenu", (e) => {
			if (!pluginSettings.rightClickPaste) return;
			e.preventDefault();
			const sel = this.terminal.getSelection();
			const menu = new Menu();
			if (sel) {
				menu.addItem((item) => item.setTitle("Copy").setIcon("copy")
					.onClick(() => navigator.clipboard.writeText(sel).catch(() => {})));
			}
			menu.addItem((item) => item.setTitle("Paste").setIcon("clipboard")
				.onClick(() => {
					navigator.clipboard.readText().then((text) => {
						if (!text) return;
						const clean = pluginSettings.stripFormattingOnPaste ? stripAnsiRaw(text) : text;
						this.terminal.input(clean, true);
					}).catch(() => {});
				}));
			menu.addItem((item) => item.setTitle("Clear").setIcon("eraser")
				.onClick(() => this.terminal.clear()));
			menu.showAtMouseEvent(e as MouseEvent);
		});

		this.terminal.onSelectionChange(() => {
			if (!pluginSettings.copyOnSelect) return;
			const sel = this.terminal.getSelection();
			if (sel) navigator.clipboard.writeText(sel).catch(() => {});
		});

		this.setupDragAndDrop(app);
	}

	private setupDragAndDrop(app: App): void {
		const opt = { capture: true };
		let dragCounter = 0;
		this.containerEl.addEventListener("dragover", (e) => {
			e.preventDefault(); e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		}, opt);
		this.containerEl.addEventListener("dragenter", (e) => {
			e.preventDefault(); e.stopPropagation();
			if (++dragCounter === 1) this.showDropZone();
		}, opt);
		this.containerEl.addEventListener("dragleave", (e) => {
			e.preventDefault(); e.stopPropagation();
			if (--dragCounter <= 0) { dragCounter = 0; this.hideDropZone(); }
		}, opt);
		this.containerEl.addEventListener("drop", (e) => {
			e.preventDefault(); e.stopPropagation();
			dragCounter = 0; this.hideDropZone();
			this.handleDrop(e as DragEvent, app);
		}, opt);
	}

	setActivityCallback(cb: ((s: TerminalSession) => void) | null): void {
		this._activityCallback = cb;
	}

	private showDropZone(): void {
		if (this.dropZoneEl) return;
		this.dropZoneEl = this.containerEl.createDiv({ cls: "vin-terminal-dropzone" });
		this.dropZoneEl.createSpan({ cls: "vin-dropzone-label", text: "Drop file here" });
		requestAnimationFrame(() => this.dropZoneEl?.addClass("is-visible"));
	}

	private hideDropZone(): void {
		if (!this.dropZoneEl) return;
		this.dropZoneEl.remove(); this.dropZoneEl = null;
	}

	private showDropBadge(filePaths: string[]): void {
		if (this.dropBadgeTimer) clearTimeout(this.dropBadgeTimer);
		this.containerEl.querySelector(".vin-drop-badge")?.remove();
		const pathMod = require("path");
		const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
		const badge = this.containerEl.createDiv({ cls: "vin-drop-badge" });
		for (const fp of filePaths) {
			const item = badge.createDiv({ cls: "vin-drop-badge-item" });
			const ext = pathMod.extname(fp).toLowerCase();
			if (IMAGE_EXTS.has(ext)) {
				const thumb = item.createEl("img", { cls: "vin-drop-badge-thumb" });
				thumb.src = `file://${fp}`;
			}
			item.createSpan({ cls: "vin-drop-badge-name", text: pathMod.basename(fp) });
		}
		requestAnimationFrame(() => badge.addClass("is-visible"));
		this.dropBadgeTimer = setTimeout(() => {
			badge.removeClass("is-visible");
			setTimeout(() => badge.remove(), 300);
		}, 3000);
	}

	private handleDrop(e: DragEvent, app: App): void {
		const paths: string[] = [];
		const vaultPath = (app.vault.adapter as any).basePath as string | undefined;
		const pathMod = require("path");

		if (e.dataTransfer?.files?.length) {
			for (let i = 0; i < e.dataTransfer.files.length; i++) {
				const f = e.dataTransfer.files[i] as File & { path?: string };
				if (f.path) paths.push(f.path);
			}
		}
		if (paths.length === 0 && e.dataTransfer?.files?.length) {
			const images = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
			if (images.length) { this.saveDroppedImages(images); return; }
		}
		if (paths.length === 0 && e.dataTransfer) {
			const uriList = e.dataTransfer.getData("text/uri-list")?.trim();
			if (uriList) {
				for (const uri of uriList.split("\n")) {
					const trimmed = uri.trim();
					if (trimmed.startsWith("file://")) {
						try { paths.push(decodeURIComponent(trimmed.replace("file://", ""))); } catch {}
					} else if (trimmed.startsWith("app://") && vaultPath) {
						const m = trimmed.match(/app:\/\/[^/]+\/(.+)/);
						if (m) paths.push(pathMod.join(vaultPath, decodeURIComponent(m[1])));
					}
				}
			}
			if (!paths.length) {
				const plain = e.dataTransfer.getData("text/plain")?.trim();
				if (plain && !plain.startsWith("http") && !plain.startsWith("data:") && vaultPath) {
					paths.push(pathMod.join(vaultPath, plain));
				}
			}
		}
		if (!paths.length) return;
		this.process.stdin?.write(paths.map((p) => this.shellEscape(p)).join(" "));
		this.showDropBadge(paths);
	}

	private async saveDroppedImages(files: File[]): Promise<void> {
		const os = require("os");
		const fs = require("fs");
		const pathMod = require("path");
		const saved: string[] = [];
		for (const file of files) {
			const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
			const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const tmpPath = pathMod.join(os.tmpdir(), `drop-${ts}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
			try { fs.writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer())); saved.push(tmpPath); }
			catch (err) { console.error("[vin-terminal] failed to save dropped image:", err); }
		}
		if (!saved.length) return;
		this.process.stdin?.write(saved.map((p) => this.shellEscape(p)).join(" "));
		this.showDropBadge(saved);
	}

	private shellEscape(p: string): string {
		if (/^[a-zA-Z0-9_.\/\-]+$/.test(p)) return p;
		return "'" + p.replace(/'/g, "'\\''") + "'";
	}

	captureOutput(): string {
		const sel = this.terminal.getSelection();
		if (sel?.trim()) return sel;
		const buf = this.terminal.buffer.active;
		const lines: string[] = [];
		for (let i = Math.max(0, buf.length - 50); i < buf.length; i++) {
			const line = buf.getLine(i)?.translateToString(true);
			if (line !== undefined) lines.push(line);
		}
		return lines.join("\n").trimEnd();
	}

	fit(): void { try { this.fitAddon.fit(); } catch {} }

	focus(): void {
		const attempt = (retries: number) => {
			if (this.textareaEl) this.textareaEl.focus({ preventScroll: true });
			else this.terminal.focus();
			if (document.activeElement !== this.textareaEl && retries > 0)
				requestAnimationFrame(() => attempt(retries - 1));
		};
		attempt(10);
	}

	show(skipFocus = false): void {
		this.containerEl.addClass("is-active");
		requestAnimationFrame(() => { this.fit(); if (!skipFocus) this.focus(); });
	}

	hide(): void { this.containerEl.removeClass("is-active"); }

	updateTheme(): void { this.terminal.options.theme = getObsidianTheme(); }

	updateOptions(): void {
		this.terminal.options.fontSize = pluginSettings.fontSize;
		this.terminal.options.fontFamily = pluginSettings.fontFamily;
		this.terminal.options.cursorStyle = pluginSettings.cursorStyle;
		this.terminal.options.cursorBlink = pluginSettings.cursorBlink;
		this.fit();
	}

	addBookmark(label?: string): void { this.bookmarkManager?.addBookmark(label); }
	nextBookmark(): void { this.bookmarkManager?.jumpNext(); }
	prevBookmark(): void { this.bookmarkManager?.jumpPrev(); }
	clearBookmarks(): void { this.bookmarkManager?.clearAll(); }

	destroy(): void {
		this.bookmarkManager?.destroy();
		this.autocomplete?.destroy();
		try { this.process.kill("SIGTERM"); } catch {}
		this.terminal.dispose();
		this.containerEl.remove();
	}
}

// ─── FullscreenManager ────────────────────────────────────────────────────────

class FullscreenManager {
	static overlayOpen = false;

	private overlay: HTMLElement | null = null;
	private tabBarEl: HTMLElement | null = null;
	private gridEl: HTMLElement | null = null;
	private savedPositions = new Map<TerminalSession, { parent: Element; nextSibling: ChildNode | null }>();
	private layout: LayoutMode = "single";
	private focusedSession: TerminalSession | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private isRenaming = false;

	constructor(private readonly view: TerminalView) {}

	get isOpen(): boolean { return this.overlay !== null; }
	toggle(): void { if (this.isOpen) this.exit(); else this.enter(); }

	enter(layout?: LayoutMode): void {
		if (this.isOpen || FullscreenManager.overlayOpen || !this.view.sessions.length) return;
		FullscreenManager.overlayOpen = true;
		if (layout) this.layout = layout;
		this.focusedSession = this.view.activeSession ?? this.view.sessions[0];
		this.overlay = document.createElement("div");
		this.overlay.className = "vin-fullscreen-overlay";
		this.tabBarEl = this.overlay.createDiv({ cls: "vin-fs-tab-bar" });
		this.gridEl = this.overlay.createDiv({ cls: "vin-fullscreen-grid" });
		this.gridEl.dataset.layout = this.layout;
		this.overlay.addEventListener("keydown", (e) => { if (!e.metaKey) e.stopPropagation(); });
		this.overlay.addEventListener("wheel", (e) => e.stopPropagation());
		this.overlay.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && !this.isRenaming) {
				const anyAc = this.view.sessions.some((s) => s.autocomplete?.active);
				if (!anyAc) { e.preventDefault(); e.stopPropagation(); this.exit(); }
			}
		});
		this.saveAndMoveAll();
		this.setupActivityCallbacks();
		document.body.appendChild(this.overlay);
		requestAnimationFrame(() => this.overlay?.classList.add("is-visible"));
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer) clearTimeout(this.resizeTimer);
			this.resizeTimer = setTimeout(() => this.fitAllVisible(), 60);
		});
		this.resizeObserver.observe(this.gridEl);
		setTimeout(() => this.fitAllVisible(), 100);
	}

	exit(): void {
		if (!this.overlay) return;
		this.overlay.style.pointerEvents = "none";
		this.overlay.classList.remove("is-visible");
		const overlay = this.overlay;
		setTimeout(() => overlay.remove(), 150);
		this.overlay = null; this.tabBarEl = null; this.gridEl = null;
		FullscreenManager.overlayOpen = false;
		this.clearActivityCallbacks();
		try { this.restoreAll(); } catch (e) { console.error("[vin-terminal] restoreAll error:", e); }
		this.resizeObserver?.disconnect(); this.resizeObserver = null;
		if (this.resizeTimer) clearTimeout(this.resizeTimer);
		const target = this.focusedSession && this.view.sessions.includes(this.focusedSession)
			? this.focusedSession : this.view.sessions[0] || null;
		this.view.activeSession = null;
		if (target) this.view.switchTo(target);
		this.view.renderTabs();
		requestAnimationFrame(() => { this.view.activeSession?.fit(); this.view.activeSession?.focus(); });
	}

	setLayout(layout: LayoutMode): void {
		if (layout === this.layout && this.gridEl) return;
		this.layout = layout;
		if (this.gridEl) this.gridEl.dataset.layout = layout;
		this.renderFsTabs();
		this.rebuildPanes();
	}

	private saveAndMoveAll(): void {
		this.savedPositions.clear();
		for (const s of this.view.sessions) {
			const parent = s.containerEl.parentElement;
			if (parent) this.savedPositions.set(s, { parent, nextSibling: s.containerEl.nextSibling });
		}
		this.renderFsTabs();
		this.rebuildPanes();
	}

	private renderFsTabs(): void {
		if (!this.tabBarEl || this.isRenaming) return;
		this.tabBarEl.empty();
		const tabsArea = this.tabBarEl.createDiv({ cls: "vin-fs-tabs" });

		for (const session of this.view.sessions) {
			const tab = tabsArea.createDiv({
				cls: ["vin-fs-tab",
					session === this.focusedSession ? "is-active" : "",
					session.hasActivity && session !== this.focusedSession ? "has-activity" : "",
				].filter(Boolean).join(" ")
			});
			const label = tab.createSpan({ cls: "vin-fs-tab-label", text: session.name });
			tab.addEventListener("click", () => {
				if (this.isRenaming) return;
				session.hasActivity = false; this.focusedSession = session;
				this.renderFsTabs(); this.rebuildPanes();
			});
			tab.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(() => this.startTabRename(tab, label, session)));
				if (this.view.sessions.length > 1) {
					menu.addItem((item) => item.setTitle("Close").setIcon("x").onClick(() => {
						this.view.closeSession(session);
						this.savedPositions.delete(session);
						if (this.focusedSession === session)
							this.focusedSession = this.view.sessions[this.view.sessions.length - 1] || null;
						this.renderFsTabs(); this.rebuildPanes();
					}));
				}
				menu.showAtMouseEvent(e);
			});
		}

		const newTab = tabsArea.createDiv({ cls: "vin-fs-tab-new", text: "+" });
		newTab.addEventListener("click", () => {
			this.view.createSession();
			const newest = this.view.sessions[this.view.sessions.length - 1];
			this.savedPositions.set(newest, { parent: newest.containerEl.parentElement!, nextSibling: newest.containerEl.nextSibling });
			this.focusedSession = newest;
			this.setupActivityCallbacks(); this.renderFsTabs(); this.rebuildPanes();
		});

		const controls = this.tabBarEl.createDiv({ cls: "vin-fs-controls" });
		const layoutGroup = controls.createDiv({ cls: "vin-fs-layout-group" });

		const LAYOUTS: { key: LayoutMode; label: string; paths: string }[] = [
			{ key: "single", label: "Single", paths: "" },
			{ key: "split-h", label: "Side by side", paths: '<line x1="6" y1="1" x2="6" y2="11"/>' },
			{ key: "split-v", label: "Stacked", paths: '<line x1="1" y1="6" x2="11" y2="6"/>' },
			{ key: "grid", label: "Grid", paths: '<line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/>' },
		];
		for (const l of LAYOUTS) {
			const btn = layoutGroup.createEl("button", { cls: "vin-fs-layout-btn" + (l.key === this.layout ? " is-active" : "") });
			btn.title = l.label;
			// Safe SVG construction via DOM
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "12"); svg.setAttribute("height", "12");
			svg.setAttribute("viewBox", "0 0 12 12"); svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.2");
			const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
			rect.setAttribute("x", "1"); rect.setAttribute("y", "1");
			rect.setAttribute("width", "10"); rect.setAttribute("height", "10"); rect.setAttribute("rx", "1");
			svg.appendChild(rect);
			if (l.key === "split-h" || l.key === "grid") {
				const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
				line.setAttribute("x1", "6"); line.setAttribute("y1", "1"); line.setAttribute("x2", "6"); line.setAttribute("y2", "11");
				svg.appendChild(line);
			}
			if (l.key === "split-v" || l.key === "grid") {
				const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
				line.setAttribute("x1", "1"); line.setAttribute("y1", "6"); line.setAttribute("x2", "11"); line.setAttribute("y2", "6");
				svg.appendChild(line);
			}
			btn.appendChild(svg);
			btn.addEventListener("click", () => this.setLayout(l.key));
		}

		const exitBtn = controls.createEl("button", { cls: "vin-fs-exit-btn" });
		setIcon(exitBtn, "minimize-2");
		exitBtn.title = "Exit fullscreen";
		exitBtn.addEventListener("click", () => this.exit());
	}

	private startTabRename(tab: HTMLElement, label: HTMLElement, session: TerminalSession): void {
		this.isRenaming = true;
		const input = document.createElement("input");
		input.type = "text"; input.value = session.name;
		input.className = "vin-fs-tab-rename";
		input.style.width = `${session.name.length + 1}ch`;
		label.replaceWith(input);
		input.addEventListener("input", () => { input.style.width = `${input.value.length + 1}ch`; });
		let finished = false;
		const finish = (save: boolean) => {
			if (finished) return; finished = true; this.isRenaming = false;
			if (save && input.value.trim()) session.name = input.value.trim();
			this.renderFsTabs(); this.rebuildPanes();
			this.view.renderTabs(); this.view.saveState();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") finish(true);
			if (e.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
		input.focus(); input.select();
	}

	private rebuildPanes(): void {
		if (!this.gridEl || this.isRenaming) return;
		this.gridEl.empty();
		const visible = this.getVisibleSessions();
		const visibleSet = new Set(visible);
		const multiPane = visible.length > 1;

		for (const session of this.view.sessions) {
			if (!visibleSet.has(session)) {
				session.containerEl.classList.remove("is-active");
				session.containerEl.style.display = "none";
				this.overlay?.appendChild(session.containerEl);
			}
		}
		for (const session of visible) {
			const pane = this.gridEl.createDiv({ cls: "vin-fullscreen-pane" + (session === this.focusedSession ? " is-focused" : "") });
			if (multiPane) pane.createDiv({ cls: "vin-fullscreen-pane-label", text: session.name });
			session.containerEl.style.display = "";
			session.containerEl.classList.add("is-active");
			pane.appendChild(session.containerEl);
			pane.addEventListener("mousedown", () => {
				if (this.focusedSession !== session) {
					session.hasActivity = false; this.focusedSession = session;
					this.gridEl?.querySelectorAll(".vin-fullscreen-pane").forEach((p) => {
						p.classList.toggle("is-focused", p === pane);
					});
					this.renderFsTabs();
				}
				session.focus();
			});
		}
		requestAnimationFrame(() => this.fitAllVisible());
	}

	private getVisibleSessions(): TerminalSession[] {
		const all = this.view.sessions;
		if (!all.length) return [];
		switch (this.layout) {
			case "single":
				return this.focusedSession && all.includes(this.focusedSession) ? [this.focusedSession] : [all[0]];
			case "split-h":
			case "split-v":
				if (all.length === 1) return [all[0]];
				if (this.focusedSession) {
					const idx = all.indexOf(this.focusedSession);
					const other = all[(idx + 1) % all.length];
					return this.focusedSession === other ? [this.focusedSession] : [this.focusedSession, other];
				}
				return all.slice(0, 2);
			case "grid": return [...all];
		}
	}

	private fitAllVisible(): void {
		if (!this.gridEl) return;
		const sessions = this.getVisibleSessions();
		for (const s of sessions) s.fit();
		if (!this.isRenaming && this.focusedSession && sessions.includes(this.focusedSession))
			this.focusedSession.focus();
	}

	private setupActivityCallbacks(): void {
		for (const session of this.view.sessions) {
			session.setActivityCallback((s) => {
				if (s !== this.focusedSession && !s.hasActivity) {
					s.hasActivity = true;
					const tabs = this.tabBarEl?.querySelectorAll(".vin-fs-tab");
					if (tabs) {
						const idx = this.view.sessions.indexOf(s);
						if (idx >= 0 && tabs[idx]) tabs[idx].classList.add("has-activity");
					}
				}
			});
		}
	}

	private clearActivityCallbacks(): void {
		for (const s of this.view.sessions) s.setActivityCallback(null);
	}

	private restoreAll(): void {
		for (const [session, saved] of this.savedPositions) {
			session.containerEl.style.display = "";
			try {
				if (saved.nextSibling && saved.nextSibling.parentNode === saved.parent)
					saved.parent.insertBefore(session.containerEl, saved.nextSibling);
				else
					saved.parent.appendChild(session.containerEl);
			} catch { this.view.sessionsEl.appendChild(session.containerEl); }
		}
		for (const session of this.view.sessions) {
			if (!this.savedPositions.has(session)) {
				session.containerEl.style.display = "";
				this.view.sessionsEl.appendChild(session.containerEl);
			}
			session.hide();
		}
		this.savedPositions.clear();
	}

	destroy(): void {
		if (this.isOpen) {
			this.restoreAll();
			this.resizeObserver?.disconnect();
			if (this.resizeTimer) clearTimeout(this.resizeTimer);
			this.overlay?.remove();
			this.overlay = null; this.tabBarEl = null; this.gridEl = null;
			FullscreenManager.overlayOpen = false;
		}
	}
}

// ─── TerminalView ─────────────────────────────────────────────────────────────

export class TerminalView extends ItemView {
	sessions: TerminalSession[] = [];
	activeSession: TerminalSession | null = null;
	nextId = 1;
	tabBarEl!: HTMLElement;
	sessionsEl!: HTMLElement;
	fullscreenManager: FullscreenManager | null = null;

	private composeEl: HTMLElement | null = null;
	private composeTextarea: HTMLTextAreaElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private isRenaming = false;

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return "Wolf Terminal"; }
	getIcon(): string { return WOLF_ICON_ID; }

	getState() {
		return {
			sessions: this.sessions.map((s) => ({ id: s.id, name: s.name })),
			activeId: this.activeSession?.id ?? null,
			nextId: this.nextId,
		};
	}

	async setState(state: any, result: any): Promise<void> {
		if (state?.sessions?.length > 0) {
			for (const s of this.sessions) s.destroy();
			this.sessions = []; this.activeSession = null;
			this.nextId = state.nextId ?? 1;
			const vaultPath = (this.app.vault.adapter as any).basePath as string;
			for (const saved of state.sessions) {
				const id = saved.id ?? this.nextId++;
				if (id >= this.nextId) this.nextId = id + 1;
				const session = new TerminalSession(this.sessionsEl, id, vaultPath, this.app);
				session.name = saved.name ?? `zsh ${id}`;
				this.sessions.push(session);
				session.hide();
			}
			const target = this.sessions.find((s) => s.id === state.activeId) ?? this.sessions[0];
			if (target) this.switchTo(target);
			this.renderTabs();
		}
		return super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("vin-terminal-container");
		container.addEventListener("keydown", (e) => { if (!e.metaKey) e.stopPropagation(); });
		container.addEventListener("wheel", (e) => e.stopPropagation());
		container.addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement).closest(".vin-terminal-tab-bar")) return;
			if ((e.target as HTMLElement).closest(".vin-compose-box")) return;
			setTimeout(() => this.activeSession?.focus(), 0);
		});
		this.tabBarEl = container.createDiv({ cls: "vin-terminal-tab-bar" });

		// Compose box — always in DOM between tab bar and sessions, shown/hidden via class
		this.composeEl = container.createDiv({ cls: "vin-compose-box" + (pluginSettings.composeBox ? "" : " is-hidden") });
		const composeTextarea = this.composeEl.createEl("textarea", { cls: "vin-compose-input" });
		composeTextarea.placeholder = "Compose a command\u2026 Ctrl+Enter to send";
		composeTextarea.rows = 2;
		this.composeTextarea = composeTextarea;
		const composeFooter = this.composeEl.createDiv({ cls: "vin-compose-footer" });
		composeFooter.createSpan({ cls: "vin-compose-hint", text: "Ctrl+Enter \u00b7 send   Esc \u00b7 clear" });
		const composeBtn = composeFooter.createEl("button", { cls: "vin-compose-send", text: "Send" });
		const sendCompose = () => {
			const text = composeTextarea.value.trim();
			if (!text) return;
			this.activeSession?.process.stdin?.write(text + "\n");
			composeTextarea.value = "";
			this.activeSession?.focus();
		};
		composeTextarea.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); sendCompose(); }
			if (e.key === "Escape") { e.preventDefault(); composeTextarea.value = ""; }
		});
		composeBtn.addEventListener("click", sendCompose);

		this.sessionsEl = container.createDiv({ cls: "vin-terminal-sessions" });
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer) clearTimeout(this.resizeTimer);
			this.resizeTimer = setTimeout(() => this.activeSession?.fit(), 60);
		});
		this.resizeObserver.observe(this.sessionsEl);
		this.fullscreenManager = new FullscreenManager(this);
		this.registerEvent(this.app.workspace.on("css-change", () => {
			for (const s of this.sessions) s.updateTheme();
		}));
		let followDebounce: ReturnType<typeof setTimeout> | null = null;
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (!pluginSettings.followActiveNote || !file || file.extension !== "md") return;
			if (followDebounce) clearTimeout(followDebounce);
			const vaultPath = (this.app.vault.adapter as any).basePath as string;
			if (!vaultPath) return;
			const parentPath = file.parent?.path ?? "";
			const path = require("path");
			const fs = require("fs");
			const newCwd = parentPath && parentPath !== "/" ? path.join(vaultPath, parentPath) : vaultPath;
			if (!fs.existsSync(newCwd)) return;
			followDebounce = setTimeout(() => {
				followDebounce = null;
				const session = this.activeSession;
				if (!session) return;
				const escaped = newCwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
				session.process.stdin?.write(`cd "${escaped}"\n`);
			}, 300);
		}));
		this.createSession();
	}

	createSession(name?: string): void {
		const id = this.nextId++;
		const vaultPath = (this.app.vault.adapter as any).basePath as string;
		const cwd = pluginSettings.autoCdOnOpen ? this.resolveNoteCwd() : vaultPath;
		const session = new TerminalSession(this.sessionsEl, id, cwd, this.app);
		if (name) session.name = name;
		this.sessions.push(session);
		this.switchTo(session);
		this.renderTabs();
		this.saveState();
	}

	private resolveNoteCwd(): string {
		const vaultPath = (this.app.vault.adapter as any).basePath as string;
		if (!vaultPath) return process.env.HOME ?? "";
		try {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile || activeFile.extension !== "md") return vaultPath;
			const parentPath = activeFile.parent?.path ?? "";
			if (!parentPath || parentPath === "/") return vaultPath;
			const path = require("path");
			const fs = require("fs");
			const resolved = path.join(vaultPath, parentPath);
			return fs.existsSync(resolved) ? resolved : vaultPath;
		} catch { return vaultPath; }
	}

	saveState(): void { this.app.workspace.requestSaveLayout(); }

	setComposeBox(show: boolean): void {
		this.composeEl?.classList.toggle("is-hidden", !show);
	}

	switchTo(session: TerminalSession): void {
		if (session === this.activeSession) return;
		if (this.activeSession) this.activeSession.hide();
		this.activeSession = session;
		session.show(this.isRenaming);
		this.renderTabs();
		this.saveState();
	}

	closeSession(session: TerminalSession): void {
		session.destroy();
		this.sessions = this.sessions.filter((s) => s !== session);
		if (this.activeSession === session) {
			this.activeSession = null;
			if (this.sessions.length) this.switchTo(this.sessions[this.sessions.length - 1]);
		}
		this.renderTabs();
		this.saveState();
	}

	renderTabs(): void {
		if (this.isRenaming) return;
		this.tabBarEl.empty();
		const tabsArea = this.tabBarEl.createDiv({ cls: "vin-terminal-tabs-scroll" });
		for (const session of this.sessions) {
			const tab = tabsArea.createDiv({ cls: "vin-terminal-tab" + (session === this.activeSession ? " is-active" : "") });
			const label = tab.createSpan({ cls: "tab-label", text: session.name });
			tab.addEventListener("click", () => this.switchTo(session));
			tab.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(() => this.startRename(tab, label, session)));
				menu.addItem((item) => item.setTitle("Close").setIcon("x").onClick(() => this.closeSession(session)));
				menu.showAtMouseEvent(e);
			});
		}
		const newBtn = tabsArea.createDiv({ cls: "vin-terminal-tab-new", text: "+" });
		newBtn.addEventListener("click", () => this.createSession());
		const controls = this.tabBarEl.createDiv({ cls: "vin-terminal-tab-controls" });
		const fsBtn = controls.createDiv({ cls: "vin-terminal-tab-fullscreen" });
		setIcon(fsBtn, "expand"); fsBtn.title = "Fullscreen";
		fsBtn.addEventListener("click", () => this.fullscreenManager?.toggle());
		const helpBtn = controls.createDiv({ cls: "vin-terminal-tab-help", text: "?" });
		helpBtn.title = "Shortcuts";
		helpBtn.addEventListener("click", () => new ShortcutsModal(this.app).open());
	}

	private startRename(tab: HTMLElement, label: HTMLElement, session: TerminalSession): void {
		this.isRenaming = true;
		const input = document.createElement("input");
		input.type = "text"; input.value = session.name;
		input.className = "vin-terminal-tab-rename";
		input.style.width = `${session.name.length + 1}ch`;
		label.replaceWith(input);
		input.addEventListener("input", () => { input.style.width = `${input.value.length + 1}ch`; });
		const finish = (save: boolean) => {
			if (!this.isRenaming) return;
			this.isRenaming = false;
			if (save && input.value.trim()) session.name = input.value.trim();
			this.renderTabs(); this.saveState();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") finish(true);
			if (e.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
		input.focus(); input.select();
	}

	async onClose(): Promise<void> {
		this.fullscreenManager?.destroy(); this.fullscreenManager = null;
		this.resizeObserver?.disconnect();
		for (const s of this.sessions) s.destroy();
		this.sessions = []; this.activeSession = null;
	}
}

// ─── ShortcutsModal ───────────────────────────────────────────────────────────

class ShortcutsModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("vin-shortcuts-modal");
		contentEl.createEl("h3", { text: "Wolf Terminal Shortcuts" });
		const shortcuts: [string, string][] = [
			["Cmd+Shift+S", "Capture output to note"],
			["Cmd+Shift+M", "Add bookmark"],
			["Cmd+Shift+]", "Next bookmark"],
			["Cmd+Shift+[", "Previous bookmark"],
			["Escape", "Exit fullscreen"],
			["[[ ...", "Wiki-link autocomplete"],
		];
		const table = contentEl.createEl("table");
		for (const [key, desc] of shortcuts) {
			const row = table.createEl("tr");
			row.createEl("td").createEl("kbd", { text: key });
			row.createEl("td", { text: desc });
		}
		contentEl.createEl("p", {
			text: "Open, fullscreen, and tab commands have no default hotkeys. Assign them in Settings > Hotkeys.",
			cls: "vin-shortcuts-hint",
		});
	}
	onClose(): void { this.contentEl.empty(); }
}

// ─── OutputCaptureModal ───────────────────────────────────────────────────────

class OutputCaptureModal extends SuggestModal<CaptureOption> {
	constructor(app: App, private readonly capturedText: string) {
		super(app);
		this.setPlaceholder("Choose where to save terminal output...");
	}
	getSuggestions(): CaptureOption[] {
		return [
			{ label: "Today's daily note", action: "daily" },
			{ label: "Current open note", action: "current" },
			{ label: "New note", action: "new" },
		];
	}
	renderSuggestion(option: CaptureOption, el: HTMLElement): void {
		el.createEl("div", { text: option.label });
	}
	async onChooseSuggestion(option: CaptureOption): Promise<void> {
		const now = new Date();
		const hh = String(now.getHours()).padStart(2, "0");
		const mm = String(now.getMinutes()).padStart(2, "0");
		const block = `\n**Terminal Capture — ${hh}:${mm}**\n\n${this.capturedText}\n`;
		if (option.action === "daily") {
			const yyyy = now.getFullYear();
			const mo = String(now.getMonth() + 1).padStart(2, "0");
			const dd = String(now.getDate()).padStart(2, "0");
			const dailyPath = `Daily Notes/${yyyy}-${mo}-${dd}.md`;
			const exists = await this.app.vault.adapter.exists(dailyPath);
			if (exists) await this.app.vault.adapter.append(dailyPath, block);
			else await this.app.vault.create(dailyPath, block.trimStart());
		} else if (option.action === "current") {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) await this.app.vault.adapter.append(activeFile.path, block);
		} else if (option.action === "new") {
			const ss = String(now.getSeconds()).padStart(2, "0");
			const yyyy = now.getFullYear();
			const mo = String(now.getMonth() + 1).padStart(2, "0");
			const dd = String(now.getDate()).padStart(2, "0");
			const newPath = `Terminal Captures/${yyyy}-${mo}-${dd}-${hh}${mm}${ss}.md`;
			if (!(await this.app.vault.adapter.exists("Terminal Captures")))
				await this.app.vault.createFolder("Terminal Captures");
			await this.app.vault.create(newPath, block.trimStart());
		}
	}
}

// ─── TerminalSettingTab ───────────────────────────────────────────────────────

class TerminalSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TerminalPlugin) { super(app, plugin); }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Wolf Terminal" });
		containerEl.createEl("p", {
			text: "Embedded terminal with tabs, bookmarks, wiki-link autocomplete, and output capture.",
			cls: "vin-settings-desc",
		});

		// ─── Paste & Selection ────────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Paste & Selection", cls: "vin-settings-section" });
		new Setting(containerEl)
			.setName("Strip formatting on paste")
			.setDesc("Remove ANSI color codes on paste. Fixes garbled output when copying from Claude Code or other terminal emulators.")
			.addToggle((t) => t.setValue(this.plugin.settings.stripFormattingOnPaste).onChange(async (v) => {
				this.plugin.settings.stripFormattingOnPaste = v; await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Right-click paste")
			.setDesc("Right-click inside the terminal to paste from clipboard. If text is selected, right-click copies it instead.")
			.addToggle((t) => t.setValue(this.plugin.settings.rightClickPaste).onChange(async (v) => {
				this.plugin.settings.rightClickPaste = v; await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Copy on select")
			.setDesc("Automatically copy selected text to clipboard when you release the mouse.")
			.addToggle((t) => t.setValue(this.plugin.settings.copyOnSelect).onChange(async (v) => {
				this.plugin.settings.copyOnSelect = v; await this.plugin.saveSettings();
			}));

		// ─── Appearance ───────────────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Appearance", cls: "vin-settings-section" });
		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Terminal font size in pixels (10–20).")
			.addSlider((s) => s.setLimits(10, 20, 0.5).setValue(this.plugin.settings.fontSize).setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.fontSize = v; await this.plugin.saveSettings();
					this.plugin.updateAllViews();
				}));
		new Setting(containerEl)
			.setName("Font family")
			.setDesc("Monospace font stack. Comma-separated fallbacks.")
			.addText((t) => t.setValue(this.plugin.settings.fontFamily).setPlaceholder("'SF Mono', monospace")
				.onChange(async (v) => {
					this.plugin.settings.fontFamily = v.trim() || DEFAULT_SETTINGS.fontFamily;
					await this.plugin.saveSettings(); this.plugin.updateAllViews();
				}));
		new Setting(containerEl)
			.setName("Cursor style")
			.setDesc("Shape of the terminal cursor.")
			.addDropdown((d) => d
				.addOption("block", "Block").addOption("underline", "Underline").addOption("bar", "Bar")
				.setValue(this.plugin.settings.cursorStyle)
				.onChange(async (v) => {
					this.plugin.settings.cursorStyle = v as "block" | "underline" | "bar";
					await this.plugin.saveSettings(); this.plugin.updateAllViews();
				}));
		new Setting(containerEl)
			.setName("Cursor blink")
			.addToggle((t) => t.setValue(this.plugin.settings.cursorBlink).onChange(async (v) => {
				this.plugin.settings.cursorBlink = v; await this.plugin.saveSettings();
				this.plugin.updateAllViews();
			}));
		new Setting(containerEl)
			.setName("Bell style")
			.setDesc("How to respond to the terminal bell character.")
			.addDropdown((d) => d
				.addOption("none", "None (silent)").addOption("visual", "Visual flash")
				.setValue(this.plugin.settings.bellStyle)
				.onChange(async (v) => {
					this.plugin.settings.bellStyle = v as "none" | "visual";
					await this.plugin.saveSettings(); this.plugin.updateAllViews();
				}));

		// ─── Buffer ───────────────────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Buffer", cls: "vin-settings-section" });
		new Setting(containerEl)
			.setName("Scrollback lines")
			.setDesc("Lines to keep in the scroll buffer. Higher values use more memory. Takes effect on new tabs.")
			.addText((t) => t.setValue(String(this.plugin.settings.scrollback)).setPlaceholder("5000")
				.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) { this.plugin.settings.scrollback = n; await this.plugin.saveSettings(); }
				}));

		// ─── Shell ────────────────────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Shell", cls: "vin-settings-section" });
		new Setting(containerEl)
			.setName("Shell path")
			.setDesc("Path to the shell executable. Takes effect on new tabs.")
			.addText((t) => t.setValue(this.plugin.settings.shell).setPlaceholder("/bin/zsh")
				.onChange(async (v) => {
					this.plugin.settings.shell = v.trim() || "/bin/zsh"; await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("Startup command")
			.setDesc("Command to run after the shell initializes in each new tab (e.g. source ~/.work_env).")
			.addText((t) => t.setValue(this.plugin.settings.startupCommand).setPlaceholder("source ~/.work_env")
				.onChange(async (v) => {
					this.plugin.settings.startupCommand = v; await this.plugin.saveSettings();
				}));

		// ─── Input ────────────────────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Input", cls: "vin-settings-section" });
		new Setting(containerEl)
			.setName("Compose box")
			.setDesc("Show a multi-line text editor above the terminal. Write and edit a command freely, then send it with Ctrl+Enter.")
			.addToggle((t) => t.setValue(this.plugin.settings.composeBox).onChange(async (v) => {
				this.plugin.settings.composeBox = v; await this.plugin.saveSettings();
				this.plugin.updateAllViews();
			}));

		// ─── Navigation ───────────────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Navigation", cls: "vin-settings-section" });
		new Setting(containerEl)
			.setName("Auto-cd to active note on open")
			.setDesc("When you open a new terminal tab, start in the directory of your currently active note instead of the vault root.")
			.addToggle((t) => t.setValue(this.plugin.settings.autoCdOnOpen).onChange(async (v) => {
				this.plugin.settings.autoCdOnOpen = v; await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Follow active note")
			.setDesc("When you switch to a different note, automatically cd the terminal to that note's directory. Debounced 300ms.")
			.addToggle((t) => t.setValue(this.plugin.settings.followActiveNote).onChange(async (v) => {
				this.plugin.settings.followActiveNote = v; await this.plugin.saveSettings();
			}));

		// ─── Keyboard shortcuts ───────────────────────────────────────────────────
		containerEl.createEl("span", { text: "Keyboard shortcuts", cls: "vin-settings-section" });
		const table = containerEl.createEl("table", { cls: "vin-settings-shortcuts-table" });
		const shortcuts: [string, string][] = [
			["Capture output to note", "⌘⇧S"],
			["Add bookmark", "⌘⇧M"],
			["Next bookmark", "⌘⇧]"],
			["Previous bookmark", "⌘⇧["],
			["Compose box: send", "Ctrl+Enter"],
			["Compose box: clear", "Esc"],
			["Toggle fullscreen", "via command palette"],
		];
		for (const [label, key] of shortcuts) {
			const row = table.createEl("tr");
			row.createEl("td", { text: label });
			row.createEl("td").createEl("kbd", { text: key });
		}
	}
}

// ─── TerminalPlugin ───────────────────────────────────────────────────────────

export default class TerminalPlugin extends Plugin {
	settings!: TerminalSettings;

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		pluginSettings = this.settings;
		await this.saveData(this.settings);
	}

	updateAllViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view as TerminalView;
			view.setComposeBox(pluginSettings.composeBox);
			for (const session of view.sessions) session.updateOptions();
		}
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		pluginSettings = this.settings;
		addIcon(WOLF_ICON_ID, WOLF_ICON_SVG);

		const fs = require("fs");
		const path = require("path");
		const vaultBase = (this.app.vault.adapter as any).basePath as string;
		const helperPath = path.join(vaultBase, this.manifest.dir, "pty-helper.py");
		fs.writeFileSync(helperPath, PTY_HELPER_SRC, { mode: 0o755 });
		ptyHelperPath = helperPath;

		if (!python3Available()) {
			new Notice("Wolf Terminal: python3 not found.\nFix: brew install python3\nThen reload Obsidian.");
		}

		this.addSettingTab(new TerminalSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf));
		this.addRibbonIcon(WOLF_ICON_ID, "Open Wolf Terminal", () => { this.toggleTerminalSide(); });

		this.addCommand({ id: "open-terminal", name: "Open Terminal", callback: () => this.toggleTerminalSide() });
		this.addCommand({ id: "open-terminal-tab", name: "Open Terminal in Tab", callback: () => this.openTerminalTab() });
		this.addCommand({
			id: "toggle-fullscreen", name: "Toggle Fullscreen Terminal",
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (leaves.length) (leaves[0].view as TerminalView).fullscreenManager?.toggle();
			},
		});
		this.addCommand({
			id: "capture-terminal-output", name: "Capture Terminal Output to Note",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (!leaves.length) return;
				const session = (leaves[0].view as TerminalView).activeSession;
				if (!session) return;
				const text = session.captureOutput();
				if (text.trim()) new OutputCaptureModal(this.app, text).open();
			},
		});
		this.addCommand({
			id: "add-bookmark", name: "Add Terminal Bookmark",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (leaves.length) (leaves[0].view as TerminalView).activeSession?.addBookmark();
			},
		});
		this.addCommand({
			id: "next-bookmark", name: "Next Terminal Bookmark",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "]" }],
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (leaves.length) (leaves[0].view as TerminalView).activeSession?.nextBookmark();
			},
		});
		this.addCommand({
			id: "prev-bookmark", name: "Previous Terminal Bookmark",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "[" }],
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (leaves.length) (leaves[0].view as TerminalView).activeSession?.prevBookmark();
			},
		});
		this.addCommand({
			id: "clear-bookmarks", name: "Clear Terminal Bookmarks",
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
				if (leaves.length) (leaves[0].view as TerminalView).activeSession?.clearBookmarks();
			},
		});
		this.addCommand({ id: "show-shortcuts", name: "Show Terminal Shortcuts", callback: () => new ShortcutsModal(this.app).open() });

		this.app.workspace.onLayoutReady(() => this.ensureLeaf());
	}

	private async ensureLeaf(): Promise<void> {
		if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return;
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: false });
	}

	async toggleTerminalSide(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length) {
			const leaf = existing[0];
			if (leaf.view.containerEl.isShown()) {
				const parent = leaf.view.containerEl.closest(".workspace-split");
				if (parent && !parent.classList.contains("is-collapsed")) {
					(this.app.workspace as any).rightSplit.collapse();
					return;
				}
			}
			this.app.workspace.revealLeaf(leaf);
			return;
		}
		await this.ensureLeaf();
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length) this.app.workspace.revealLeaf(leaves[0]);
	}

	async openTerminalTab(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}
}
