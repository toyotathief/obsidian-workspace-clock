const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  Notice,
  moment,
} = require("obsidian");

const CLOCK_CLASS = "forest-clock";
const POPUP_CLASS = "forest-clock-popup";

const DEFAULT_SETTINGS = {
  use24Hour: false,
  firstDayOfWeek: 0, // 0 = Sunday, 1 = Monday
  timezone: "", // "" = system / local (auto)
  logTarget: "daily", // "daily" | "active"
};

// Fallback if Intl.supportedValuesOf is unavailable
const FALLBACK_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

const MAX_HISTORY = 4;

module.exports = class ForestClock extends Plugin {
  async onload() {
    // State
    this._unloaded = false;
    this.clockEl = null;
    this.lastClockText = "";
    this.popupEl = null;
    this.popupOpen = false;

    // Stopwatch state (timestamp-based, no drift)
    this.sw = {
      running: false,
      startTime: 0, // ms epoch when current run segment started
      accumulated: 0, // ms accumulated from prior stop/start segments
      displayEl: null,
      tickInterval: null, // ~100ms smooth update
    };

    // Run history (most recent first), persisted. Each: { ms, ended }
    this.history = [];
    this.historyEl = null;

    // Settings (overwritten by loadAll)
    this.settings = Object.assign({}, DEFAULT_SETTINGS);

    // Restore persisted settings + stopwatch + history before anything reads them
    await this.loadAll();

    // Calendar view month
    const np = this.nowParts();
    this.calYear = np.y;
    this.calMonth = np.m; // 0-11
    this.calGridEl = null;
    this.calLabelEl = null;
    this.calDowEl = null;

    // Bound handlers we attach/detach manually
    this.onOutsideClick = (evt) => {
      if (!this.popupOpen) return;
      const target = evt.target;
      if (this.popupEl && this.popupEl.contains(target)) return;
      if (this.clockEl && this.clockEl.contains(target)) return;
      this.closePopup();
    };
    this.onKeyDown = (evt) => {
      if (this.popupOpen && evt.key === "Escape") {
        this.closePopup();
      }
    };

    this.addSettingTab(new ClockSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => {
      // Bail if the plugin was unloaded before layout became ready
      if (this._unloaded) return;

      this.ensureClock();

      // One interval, 1s
      this.registerInterval(
        window.setInterval(() => {
          this.updateClock();
        }, 1000)
      );

      // Re-injection on layout/leaf changes. Close any open popup so it never floats detached from a clock that just moved or got hidden
      this.registerEvent(
        this.app.workspace.on("layout-change", () => {
          this.ensureClock();
          if (this.popupOpen) this.closePopup();
        })
      );
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => {
          this.ensureClock();
          if (this.popupOpen) this.closePopup();
        })
      );
    });
  }

  onunload() {
    // Mark unloaded first so a still-pending onLayoutReady callback bails out instead of registering an interval/events on a dead Component
    this._unloaded = true;
    // Popup + its manual listeners. closePopup() owns stopwatch tickInterval
    this.closePopup();
    // Clock element
    if (this.clockEl) {
      this.clockEl.remove();
      this.clockEl = null;
    }
    // Safety sweep
    document
      .querySelectorAll("." + CLOCK_CLASS + ", ." + POPUP_CLASS)
      .forEach((el) => el.remove());
  }

  // Persistence

  async loadAll() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    const s = data.stopwatch || {};
    this.sw.running = !!s.running;
    this.sw.startTime = s.startTime || 0;
    this.sw.accumulated = s.accumulated || 0;
    this.history = Array.isArray(data.history)
      ? data.history.slice(0, MAX_HISTORY)
      : [];
  }

  persist() {
    // Fire-and-forget; callers don't need to await disk writes
    this.saveData({
      settings: this.settings,
      stopwatch: {
        running: this.sw.running,
        startTime: this.sw.startTime,
        accumulated: this.sw.accumulated,
      },
      history: this.history,
    });
  }

  // Commands (hotkey)

  registerCommands() {
    this.addCommand({
      id: "toggle-popup",
      name: "Toggle clock popup",
      callback: () => this.togglePopup(),
    });
    this.addCommand({
      id: "toggle-stopwatch",
      name: "Start/stop stopwatch",
      callback: () => (this.sw.running ? this.swStop() : this.swStart()),
    });
    this.addCommand({
      id: "reset-stopwatch",
      name: "Reset stopwatch",
      callback: () => this.swReset(),
    });
    this.addCommand({
      id: "log-session",
      name: "Add stopwatch session to note",
      callback: () => this.logSession(),
    });
    this.addCommand({
      id: "insert-timestamp",
      name: "Insert timestamp at cursor",
      editorCallback: (editor) => {
        editor.replaceSelection(this.formatClock(new Date()));
      },
    });
    this.addCommand({
      id: "open-today",
      name: "Open today's daily note",
      callback: () => this.openDailyNote(this.nowDate()),
    });
  }

  // Clock injection

  getHeaderContainer() {
    return (
      document.querySelector(
        ".workspace-split.mod-left-split .workspace-tabs.mod-top .workspace-tab-header-container"
      ) ||
      document.querySelector(
        ".workspace-split.mod-left-split .workspace-tab-header-container"
      )
    );
  }

  ensureClock() {
    const container = this.getHeaderContainer();
    if (!container) return; // skip this tick, retry on next layout-change/interval

    // If clock exists but is detached or in the wrong container move it
    if (this.clockEl && this.clockEl.isConnected) {
      if (this.clockEl.parentElement !== container) {
        container.appendChild(this.clockEl);
      }
    } else {
      // Adopt/dedupe across document, not just this container. On full workspace layout rebuild the old header container can be replaced while clock stays attached elsewhere
      const all = document.querySelectorAll("." + CLOCK_CLASS);
      let existing = null;
      all.forEach((el, i) => {
        if (i === 0) existing = el;
        else el.remove(); // kill any duplicates
      });
      if (!existing) {
        existing = document.createElement("div");
        existing.className = CLOCK_CLASS;
        existing.setAttribute("aria-label", "Clock — stopwatch & calendar");
        this.registerDomEvent(existing, "click", (evt) => {
          evt.stopPropagation();
          this.togglePopup();
        });
      }
      if (existing.parentElement !== container) {
        container.appendChild(existing);
      }
      this.clockEl = existing;
      this.lastClockText = ""; // force a write on next update
    }
    this.updateClock();
  }

  // Time helpers

  formatClock(d) {
    const opts = {
      hour: this.settings.use24Hour ? "2-digit" : "numeric",
      minute: "2-digit",
      hourCycle: this.settings.use24Hour ? "h23" : "h12",
    };
    if (this.settings.timezone) opts.timeZone = this.settings.timezone;
    try {
      return new Intl.DateTimeFormat("en-US", opts).format(d);
    } catch (e) {
      // Bad/unsupported timezone — fall back to local.
      delete opts.timeZone;
      return new Intl.DateTimeFormat("en-US", opts).format(d);
    }
  }

  // Returns { y, m (0-11), day } for "now" in the configured timezone (or local).
  nowParts() {
    const d = new Date();
    const tz = this.settings.timezone;
    if (!tz) {
      return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() };
    }
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(d);
      const map = {};
      parts.forEach((p) => (map[p.type] = p.value));
      return { y: +map.year, m: +map.month - 1, day: +map.day };
    } catch (e) {
      return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() };
    }
  }

  nowDate() {
    const p = this.nowParts();
    return new Date(p.y, p.m, p.day);
  }

  updateClock() {
    if (!this.clockEl) return;
    const text = this.formatClock(new Date());
    if (text !== this.lastClockText) {
      this.clockEl.textContent = text;
      this.lastClockText = text;
    }
  }

  // Popup

  togglePopup() {
    if (this.popupOpen) this.closePopup();
    else this.openPopup();
  }

  openPopup() {
    if (this.popupOpen || !this.clockEl) return;

    const popup = document.createElement("div");
    popup.className = POPUP_CLASS;

    // Timestamp bar
    const tsBar = popup.createEl("button", {
      cls: "forest-ts-bar",
      text: "Add timestamp to note",
    });
    this.registerDomEvent(tsBar, "click", () => this.insertTimestamp());

    popup.createDiv({ cls: "forest-divider" });

    // Stopwatch section
    const swSection = popup.createDiv({ cls: "forest-sw" });
    const swDisplay = swSection.createDiv({ cls: "forest-sw-display" });
    swDisplay.textContent = this.formatStopwatch(this.swElapsed());
    this.sw.displayEl = swDisplay;

    const swButtons = swSection.createDiv({ cls: "forest-sw-buttons" });
    const startBtn = swButtons.createEl("button", { text: "Start" });
    const stopBtn = swButtons.createEl("button", { text: "Stop" });
    const resetBtn = swButtons.createEl("button", { text: "Reset" });
    swButtons.createDiv({ cls: "forest-sw-sep" });
    const logBtn = swButtons.createEl("button", { text: "Log" });

    this.registerDomEvent(startBtn, "click", () => this.swStart());
    this.registerDomEvent(stopBtn, "click", () => this.swStop());
    this.registerDomEvent(resetBtn, "click", () => this.swReset());
    this.registerDomEvent(logBtn, "click", () => this.logSession());

    // Run history chips
    const history = swSection.createDiv({ cls: "forest-sw-history" });
    this.historyEl = history;

    // Calendar section
    const calSection = popup.createDiv({ cls: "forest-cal" });
    const calHeader = calSection.createDiv({ cls: "forest-cal-header" });
    const prevBtn = calHeader.createEl("button", {
      text: "‹",
      cls: "forest-cal-nav",
    });
    const label = calHeader.createDiv({ cls: "forest-cal-label" });
    const nextBtn = calHeader.createEl("button", {
      text: "›",
      cls: "forest-cal-nav",
    });
    this.calLabelEl = label;

    const dow = calSection.createDiv({ cls: "forest-cal-grid forest-cal-dow" });
    this.calDowEl = dow;

    const grid = calSection.createDiv({ cls: "forest-cal-grid forest-cal-days" });
    this.calGridEl = grid;

    this.registerDomEvent(prevBtn, "click", () => {
      this.calMonth--;
      if (this.calMonth < 0) {
        this.calMonth = 11;
        this.calYear--;
      }
      this.renderCalendar();
    });
    this.registerDomEvent(nextBtn, "click", () => {
      this.calMonth++;
      if (this.calMonth > 11) {
        this.calMonth = 0;
        this.calYear++;
      }
      this.renderCalendar();
    });

    document.body.appendChild(popup);
    this.popupEl = popup;
    this.popupOpen = true;

    this.positionPopup();
    this.renderHistory();
    this.renderCalendar();

    // Start smooth stopwatch updates if running
    this.maybeStartSwTick();

    // Manual listeners. Defer the outside-click binding to the next frame so the opening click doesn't immediately close the popup
    window.setTimeout(() => {
      if (!this.popupOpen) return;
      document.addEventListener("mousedown", this.onOutsideClick, true);
    }, 0);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  closePopup() {
    // Always tear down listeners even if popup element is gone
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onKeyDown, true);

    if (this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }

    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
    this.sw.displayEl = null;
    this.historyEl = null;
    this.calGridEl = null;
    this.calLabelEl = null;
    this.calDowEl = null;
    this.popupOpen = false;
  }

  positionPopup() {
    if (!this.popupEl || !this.clockEl) return;
    const rect = this.clockEl.getBoundingClientRect();
    const popupWidth = 260;
    let left = rect.right - popupWidth;
    if (left < 8) left = 8;
    const maxLeft = window.innerWidth - popupWidth - 8;
    if (left > maxLeft) left = maxLeft;
    this.popupEl.style.position = "fixed";
    this.popupEl.style.top = rect.bottom + 6 + "px";
    this.popupEl.style.left = left + "px";
    this.popupEl.style.width = popupWidth + "px";
  }

  // Stopwatch logic

  swElapsed() {
    let total = this.sw.accumulated;
    if (this.sw.running) {
      total += Date.now() - this.sw.startTime;
    }
    return total;
  }

  formatStopwatch(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    if (h > 0) {
      return h + ":" + pad(m) + ":" + pad(s);
    }
    return pad(m) + ":" + pad(s);
  }

  swStart() {
    if (this.sw.running) return;
    this.sw.running = true;
    this.sw.startTime = Date.now();
    this.persist();
    this.updateSwDisplay();
    this.maybeStartSwTick();
  }

  swStop() {
    if (!this.sw.running) return;
    this.sw.accumulated += Date.now() - this.sw.startTime;
    this.sw.running = false;
    if (this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }
    this.persist();
    this.updateSwDisplay();
  }

  swReset() {
    // Finalize the current run into history before clearing
    const elapsed = this.swElapsed();
    if (elapsed > 0) {
      this.history.unshift({ ms: elapsed, ended: Date.now() });
      if (this.history.length > MAX_HISTORY) {
        this.history = this.history.slice(0, MAX_HISTORY);
      }
    }
    this.sw.running = false;
    this.sw.accumulated = 0;
    this.sw.startTime = 0;
    if (this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }
    this.persist();
    this.updateSwDisplay();
    this.renderHistory();
  }

  // Load a past run back into the live display (stopped). Start resumes from it; Log records it
  loadRun(ms) {
    this.sw.running = false;
    this.sw.startTime = 0;
    this.sw.accumulated = ms;
    if (this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }
    this.persist();
    this.updateSwDisplay();
  }

  maybeStartSwTick() {
    // Smooth ~100ms updates only while running + popup open
    if (this.sw.running && this.popupOpen && !this.sw.tickInterval) {
      this.sw.tickInterval = window.setInterval(() => {
        this.updateSwDisplay();
      }, 100);
    }
  }

  updateSwDisplay() {
    if (this.sw.displayEl) {
      this.sw.displayEl.textContent = this.formatStopwatch(this.swElapsed());
    }
  }

  renderHistory() {
    if (!this.historyEl) return;
    this.historyEl.empty();
    this.history.forEach((run, i) => {
      const chip = this.historyEl.createDiv({ cls: "forest-sw-chip" });
      chip.createSpan({ cls: "forest-sw-chip-num", text: String(i + 1) });
      chip.createSpan({
        cls: "forest-sw-chip-dur",
        text: this.formatStopwatch(run.ms),
      });
      this.registerDomEvent(chip, "click", () => this.loadRun(run.ms));
    });
  }

  // Note writing

  insertTimestamp() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) {
      new Notice("No active note");
      return;
    }
    view.editor.replaceSelection(this.formatClock(new Date()));
  }

  sessionLine(ms) {
    return (
      "- ⏱ " +
      this.formatStopwatch(ms) +
      " — logged " +
      this.formatClock(new Date())
    );
  }

  async logSession() {
    const ms = this.swElapsed();
    if (ms <= 0) {
      new Notice("Stopwatch is at zero");
      return;
    }
    const line = this.sessionLine(ms);

    if (this.settings.logTarget === "active") {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.editor) {
        view.editor.replaceSelection(line + "\n");
        new Notice("Session logged");
      } else {
        new Notice("No active note to log to");
      }
      return;
    }

    // Daily note: append to the end
    const file = await this.resolveDailyNote(this.nowDate());
    if (file) {
      await this.app.vault.append(file, "\n" + line);
      new Notice("Session logged to daily note");
    } else {
      new Notice("Could not open daily note");
    }
  }

  // Daily notes (reads core Daily Notes settings; dependency-free)

  getDailyNoteConfig() {
    let format = "YYYY-MM-DD";
    let folder = "";
    let template = "";
    try {
      const dn = this.app.internalPlugins.getPluginById("daily-notes");
      const opts = dn && dn.instance && dn.instance.options;
      if (opts) {
        if (opts.format) format = opts.format;
        if (opts.folder) folder = opts.folder;
        if (opts.template) template = opts.template;
      }
    } catch (e) {
      // fall back to defaults
    }
    return { format, folder, template };
  }

  dailyNotePath(dateObj) {
    const { format, folder } = this.getDailyNoteConfig();
    const name = moment(dateObj).format(format);
    const dir = folder ? folder.replace(/\/+$/, "") + "/" : "";
    return dir + name + ".md";
  }

  hasDailyNote(year, month, day) {
    const path = this.dailyNotePath(new Date(year, month, day));
    return !!this.app.vault.getAbstractFileByPath(path);
  }

  async resolveDailyNote(dateObj) {
    const path = this.dailyNotePath(dateObj);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) return file;
    return this.createDailyNote(path);
  }

  async createDailyNote(path) {
    const { template, folder } = this.getDailyNoteConfig();

    // Ensure the daily-notes folder exists.
    if (folder) {
      const dir = folder.replace(/\/+$/, "");
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
        try {
          await this.app.vault.createFolder(dir);
        } catch (e) {
          // already exists / created concurrently
        }
      }
    }

    // Seed with the configured template's raw contents, no variable expansion
    let content = "";
    if (template) {
      const tplPath = template.endsWith(".md") ? template : template + ".md";
      const tplFile = this.app.vault.getAbstractFileByPath(tplPath);
      if (tplFile) {
        try {
          content = await this.app.vault.read(tplFile);
        } catch (e) {
          content = "";
        }
      }
    }

    try {
      return await this.app.vault.create(path, content);
    } catch (e) {
      // Lost a creation race, return whatever now exists at the path.
      return this.app.vault.getAbstractFileByPath(path);
    }
  }

  async openDailyNote(dateObj) {
    const file = await this.resolveDailyNote(dateObj);
    if (file) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("Could not open daily note");
    }
  }

  // Calendar logic

  renderCalendar() {
    if (!this.calGridEl || !this.calLabelEl) return;

    const fdow = this.settings.firstDayOfWeek; // 0 = Sun, 1 = Mon

    // Day-of-week header, rotated to the configured first day
    if (this.calDowEl) {
      this.calDowEl.empty();
      const base = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
      const labels = base.slice(fdow).concat(base.slice(0, fdow));
      labels.forEach((d) => {
        this.calDowEl.createDiv({
          cls: "forest-cal-cell forest-cal-dowcell",
          text: d,
        });
      });
    }

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    this.calLabelEl.textContent =
      monthNames[this.calMonth] + " " + this.calYear;

    this.calGridEl.empty();

    const firstDay = new Date(this.calYear, this.calMonth, 1).getDay(); // 0=Sun
    const offset = (firstDay - fdow + 7) % 7;
    const daysInMonth = new Date(this.calYear, this.calMonth + 1, 0).getDate();

    const np = this.nowParts();
    const isCurrentMonth = np.y === this.calYear && np.m === this.calMonth;
    const todayDate = np.day;

    // Leading blanks for first-day offset
    for (let i = 0; i < offset; i++) {
      this.calGridEl.createDiv({ cls: "forest-cal-cell forest-cal-blank" });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const cell = this.calGridEl.createDiv({
        cls: "forest-cal-cell forest-cal-day",
        text: "" + day,
      });
      if (isCurrentMonth && day === todayDate) {
        cell.addClass("forest-cal-today");
      }
      if (this.hasDailyNote(this.calYear, this.calMonth, day)) {
        cell.createSpan({ cls: "forest-cal-dot" });
      }
      this.registerDomEvent(cell, "click", () => {
        this.openDailyNote(new Date(this.calYear, this.calMonth, day));
        this.closePopup();
      });
    }
  }
};

class ClockSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("24-hour time")
      .setDesc("Show the clock in 24-hour format instead of AM/PM.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.use24Hour).onChange(async (v) => {
          this.plugin.settings.use24Hour = v;
          this.plugin.persist();
          this.plugin.lastClockText = "";
          this.plugin.updateClock();
        })
      );

    new Setting(containerEl)
      .setName("First day of week")
      .setDesc("Which day the calendar week starts on.")
      .addDropdown((d) =>
        d
          .addOption("0", "Sunday")
          .addOption("1", "Monday")
          .setValue(String(this.plugin.settings.firstDayOfWeek))
          .onChange(async (v) => {
            this.plugin.settings.firstDayOfWeek = parseInt(v, 10);
            this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("Timezone")
      .setDesc(
        "The clock follows your system timezone automatically. Override to display a specific zone."
      )
      .addDropdown((d) => {
        d.addOption("", "System (auto)");
        let zones = [];
        try {
          zones = Intl.supportedValuesOf("timeZone");
        } catch (e) {
          zones = FALLBACK_ZONES;
        }
        if (!zones || !zones.length) zones = FALLBACK_ZONES;
        zones.forEach((z) => d.addOption(z, z));
        d.setValue(this.plugin.settings.timezone);
        d.onChange(async (v) => {
          this.plugin.settings.timezone = v;
          this.plugin.persist();
          this.plugin.lastClockText = "";
          this.plugin.updateClock();
        });
      });

    new Setting(containerEl)
      .setName("Session log target")
      .setDesc("Where the stopwatch Log button writes a session.")
      .addDropdown((d) =>
        d
          .addOption("daily", "Daily note")
          .addOption("active", "Active note")
          .setValue(this.plugin.settings.logTarget)
          .onChange(async (v) => {
            this.plugin.settings.logTarget = v;
            this.plugin.persist();
          })
      );
  }
}
