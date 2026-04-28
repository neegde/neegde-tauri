import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import UpdateDialog from "../../src/components/shell/UpdateDialog.vue";

const baseProps = {
  visible: true,
  version: "0.2.0",
  date: "26 апреля 2026",
  notesHtml: "<h3>Что нового</h3><ul><li>Фича</li></ul>",
  installing: false,
  installProgress: 0,
  installError: "",
};

// Teleport renders into document.body, so we query the DOM directly.
function bodyText() { return document.body.textContent ?? ""; }
function bodyHtml() { return document.body.innerHTML; }
function bodyQ(sel: string) { return document.body.querySelector(sel); }
function bodyQAll(sel: string) { return document.body.querySelectorAll(sel); }

function cleanup() {
  document.body.innerHTML = "";
}

describe("UpdateDialog — smoke", () => {
  it("mounts when visible", () => {
    const w = mount(UpdateDialog, { props: baseProps, attachTo: document.body });
    expect(bodyHtml()).toBeTruthy();
    w.unmount(); cleanup();
  });

  it("does not render overlay when visible=false", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, visible: false },
      attachTo: document.body,
    });
    expect(bodyQ(".update-overlay")).toBeNull();
    w.unmount(); cleanup();
  });
});

describe("UpdateDialog — content", () => {
  it("shows version with v prefix", () => {
    const w = mount(UpdateDialog, { props: baseProps, attachTo: document.body });
    expect(bodyText()).toContain("v0.2.0");
    w.unmount(); cleanup();
  });

  it("shows date", () => {
    const w = mount(UpdateDialog, { props: baseProps, attachTo: document.body });
    expect(bodyText()).toContain("26 апреля 2026");
    w.unmount(); cleanup();
  });

  it("renders notesHtml via v-html", () => {
    const w = mount(UpdateDialog, { props: baseProps, attachTo: document.body });
    expect(bodyQ(".update-notes")!.innerHTML).toContain("<h3>Что нового</h3>");
    w.unmount(); cleanup();
  });

  it("shows empty notes fallback when notesHtml is empty", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, notesHtml: "" },
      attachTo: document.body,
    });
    expect(bodyQ(".update-notes--empty")).not.toBeNull();
    w.unmount(); cleanup();
  });
});

describe("UpdateDialog — events", () => {
  it("emits 'close' when 'Позже' clicked", async () => {
    const w = mount(UpdateDialog, { props: baseProps, attachTo: document.body });
    const ghostBtn = bodyQAll(".update-btn--ghost")[0] as HTMLButtonElement;
    ghostBtn.click();
    await Promise.resolve();
    expect(w.emitted("close")).toBeTruthy();
    w.unmount(); cleanup();
  });

  it("emits 'install' when primary button clicked", async () => {
    const w = mount(UpdateDialog, { props: baseProps, attachTo: document.body });
    (bodyQ(".update-btn--primary") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(w.emitted("install")).toBeTruthy();
    w.unmount(); cleanup();
  });
});

describe("UpdateDialog — installing state", () => {
  it("shows progress bar when installing", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, installing: true, installProgress: 0 },
      attachTo: document.body,
    });
    expect(bodyQ(".update-progress-wrap")).not.toBeNull();
    w.unmount(); cleanup();
  });

  it("shows indeterminate bar when progress is 0", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, installing: true, installProgress: 0 },
      attachTo: document.body,
    });
    expect(bodyQ(".update-progress-fill--indet")).not.toBeNull();
    w.unmount(); cleanup();
  });

  it("shows percentage label when progress > 0", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, installing: true, installProgress: 42 },
      attachTo: document.body,
    });
    expect(bodyText()).toContain("42%");
    w.unmount(); cleanup();
  });

  it("buttons are disabled when installing", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, installing: true, installProgress: 10 },
      attachTo: document.body,
    });
    const btns = bodyQAll("button");
    expect(btns.length).toBeGreaterThan(0);
    for (const btn of btns) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
    w.unmount(); cleanup();
  });

  it("shows installError", () => {
    const w = mount(UpdateDialog, {
      props: { ...baseProps, installError: "Ошибка загрузки" },
      attachTo: document.body,
    });
    expect(bodyQ(".update-error")!.textContent).toContain("Ошибка загрузки");
    w.unmount(); cleanup();
  });
});
