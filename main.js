const { Plugin } = require("obsidian");

const CLOCK_CLASS = "forest-clock";
const POPUP_CLASS = "forest-clock-popup";

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

    // Calendar view month
    const now = new Date();
    this.calYear = now.getFullYear();
    this.calMonth = now.getMonth(); // 0-11
    this.calGridEl = null;
    this.calLabelEl = null;

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

      // Re-injection on layout/leaf changes. Close any open popup so it never floats detached from a clock that just moved or got hidden.
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
    // Mark unloaded first so a still-pending onLayoutReady callback bails out instead of registering an interval/events on a dead Component.
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

    // If clock exists but is detached or in the wrong container move it.
    if (this.clockEl && this.clockEl.isConnected) {
      if (this.clockEl.parentElement !== container) {
        container.appendChild(this.clockEl);
      }
    } else {
      // Adopt/dedupe across document, not just this container. On full workspace layout rebuild the old header container can be replaced
      // while clock stays attached elsewhere; a container-only  would miss it and create a second
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

  formatClock(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    const mm = m < 10 ? "0" + m : "" + m;
    return h + ":" + mm + " " + ampm;
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

    // Stopwatch section
    const swSection = popup.createDiv({ cls: "forest-sw" });
    const swDisplay = swSection.createDiv({ cls: "forest-sw-display" });
    swDisplay.textContent = this.formatStopwatch(this.swElapsed());
    this.sw.displayEl = swDisplay;

    const swButtons = swSection.createDiv({ cls: "forest-sw-buttons" });
    const startBtn = swButtons.createEl("button", { text: "Start" });
    const stopBtn = swButtons.createEl("button", { text: "Stop" });
    const resetBtn = swButtons.createEl("button", { text: "Reset" });

    this.registerDomEvent(startBtn, "click", () => this.swStart());
    this.registerDomEvent(stopBtn, "click", () => this.swStop());
    this.registerDomEvent(resetBtn, "click", () => this.swReset());

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
    ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].forEach((d) => {
      dow.createDiv({ cls: "forest-cal-cell forest-cal-dowcell", text: d });
    });

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
    this.renderCalendar();

    // Start smooth stopwatch updates if running.
    this.maybeStartSwTick();

    // Manual listeners. Defer the outside-click binding to the next frame so the opening click doesn't immediately close the popup.
    window.setTimeout(() => {
      if (!this.popupOpen) return;
      document.addEventListener("mousedown", this.onOutsideClick, true);
    }, 0);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  closePopup() {
    // Always tear down listeners even if popup element is gone.
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
    this.calGridEl = null;
    this.calLabelEl = null;
    this.popupOpen = false;
  }

  positionPopup() {
    if (!this.popupEl || !this.clockEl) return;
    const rect = this.clockEl.getBoundingClientRect();
    const popupWidth = 240;
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
    this.updateSwDisplay();
  }

  swReset() {
    this.sw.running = false;
    this.sw.accumulated = 0;
    this.sw.startTime = 0;
    if (this.sw.tickInterval) {
      window.clearInterval(this.sw.tickInterval);
      this.sw.tickInterval = null;
    }
    this.updateSwDisplay();
  }

  maybeStartSwTick() {
    // Smooth ~100ms updates only while running + popup open.
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

  // Calendar logic

  renderCalendar() {
    if (!this.calGridEl || !this.calLabelEl) return;

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    this.calLabelEl.textContent =
      monthNames[this.calMonth] + " " + this.calYear;

    this.calGridEl.empty();

    const firstDay = new Date(this.calYear, this.calMonth, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(this.calYear, this.calMonth + 1, 0).getDate();

    const today = new Date();
    const isCurrentMonth =
      today.getFullYear() === this.calYear &&
      today.getMonth() === this.calMonth;
    const todayDate = today.getDate();

    // Leading blanks for first-day offset.
    for (let i = 0; i < firstDay; i++) {
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
    }
  }
};
