"use client";

import Link from "next/link";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  clearSettings, isPlausibleKey, keyHeaders, KEY_FIELDS, loadSettings, sanitizeKey, saveSettings,
  type KeyId, type Mode,
} from "@/lib/keys";

type CheckState = { ok: boolean; message: string };

export default function StartPage() {
  const [values, setValues] = useState<Record<KeyId, string>>({ youcam: "", groq: "", gemini: "" });
  const [shown, setShown] = useState<Record<KeyId, boolean>>({ youcam: false, groq: false, gemini: false });
  const [mode, setMode] = useState<Mode>("mock");
  const [status, setStatus] = useState<string>("");
  const [checks, setChecks] = useState<Partial<Record<KeyId, CheckState>>>({});
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = loadSettings();
    setValues({ youcam: stored.keys.youcam ?? "", groq: stored.keys.groq ?? "", gemini: stored.keys.gemini ?? "" });
    setMode(stored.mode);
    setReady(true);
  }, []);

  const cleaned = (id: KeyId) => sanitizeKey(values[id]);
  const problem = (id: KeyId) => {
    const key = cleaned(id);
    return key !== "" && !isPlausibleKey(key) ? "This does not look like a key. Check for spaces or missing characters." : "";
  };
  const hasProblem = KEY_FIELDS.some((field) => problem(field.id));
  const youcamKey = cleaned("youcam");

  function save(nextMode: Mode = mode): boolean {
    const keys: Partial<Record<KeyId, string>> = {};
    for (const field of KEY_FIELDS) {
      const key = cleaned(field.id);
      if (key && isPlausibleKey(key)) keys[field.id] = key;
    }
    const ok = saveSettings({ keys, mode: nextMode });
    setStatus(ok ? "Saved in this browser." : "Could not save: this browser blocks storage. Keys will work until you leave this page only if the server has them in .env.local.");
    return ok;
  }

  async function verify() {
    if (hasProblem) return;
    setBusy(true);
    setStatus("Checking keys…");
    try {
      const keys: Partial<Record<KeyId, string>> = {};
      for (const field of KEY_FIELDS) {
        const key = cleaned(field.id);
        if (key && isPlausibleKey(key)) keys[field.id] = key;
      }
      const response = await fetch("/api/keys/check", { method: "POST", headers: keyHeaders(keys) });
      const body = (await response.json().catch(() => ({}))) as Partial<Record<KeyId, CheckState>> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Check failed (${response.status}).`);
      setChecks({ youcam: body.youcam, groq: body.groq, gemini: body.gemini });
      setStatus("");
    } catch (error) {
      setChecks({});
      setStatus(error instanceof Error ? error.message : "Could not check the keys.");
    } finally {
      setBusy(false);
    }
  }

  function clearAll() {
    clearSettings();
    setValues({ youcam: "", groq: "", gemini: "" });
    setChecks({});
    setMode("mock");
    setStatus("Keys removed from this browser.");
  }

  function chooseMode(next: Mode) {
    setMode(next);
  }

  return (
    <main className="ms-start">
      <section className="ms-start-card" aria-labelledby="ms-start-title">
        <p className="ms-eyebrow">Mirror of Sovereignty</p>
        <h1 id="ms-start-title">Hands-free try-on, tuned to how you move.</h1>
        <p className="ms-lead">
          Add your API keys once. The studio measures your gaze in five seconds and adapts dwell time, target size and
          layout to you.
        </p>

        <form
          className="ms-keys"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            save();
          }}
        >
          {KEY_FIELDS.map((field) => {
            const check = checks[field.id];
            const error = problem(field.id);
            return (
              <div className="ms-field" key={field.id}>
                <label htmlFor={`key-${field.id}`}>
                  {field.label} <span>{field.required ? "required for live rendering" : "optional"}</span>
                </label>
                <div className="ms-input-row">
                  <input
                    id={`key-${field.id}`}
                    type={shown[field.id] ? "text" : "password"}
                    value={values[field.id]}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={`help-${field.id}`}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      setValues((current) => ({ ...current, [field.id]: event.target.value }));
                      setChecks((current) => ({ ...current, [field.id]: undefined }));
                    }}
                  />
                  <button type="button" className="ms-ghost" onClick={() => setShown((c) => ({ ...c, [field.id]: !c[field.id] }))}>
                    {shown[field.id] ? "Hide" : "Show"}
                  </button>
                </div>
                <p id={`help-${field.id}`} className="ms-help" data-tone={error ? "bad" : check ? (check.ok ? "ok" : "bad") : undefined}>
                  {error || (check ? check.message : field.help)}
                </p>
              </div>
            );
          })}

          <fieldset className="ms-modes">
            <legend>Renderer</legend>
            <label data-active={mode === "youcam"}>
              <input type="radio" name="mode" checked={mode === "youcam"} onChange={() => chooseMode("youcam")} />
              <b>YouCam live</b>
              <small>Real hair colour, makeup and clothes. Needs the YouCam key above (or one set on the server).</small>
            </label>
            <label data-active={mode === "mock"}>
              <input type="radio" name="mode" checked={mode === "mock"} onChange={() => chooseMode("mock")} />
              <b>Preview</b>
              <small>Draws looks locally with no key and no credits. Good for testing the controls.</small>
            </label>
          </fieldset>

          <div className="ms-actions">
            <button type="submit" className="ms-primary-alt" disabled={!ready || hasProblem}>Save</button>
            <button type="button" className="ms-ghost" disabled={busy || hasProblem || !ready} onClick={verify}>
              {busy ? "Checking…" : "Check keys"}
            </button>
            <button type="button" className="ms-ghost" onClick={clearAll}>Remove keys</button>
          </div>
          <p className="ms-status" role="status" aria-live="polite">{status}</p>
        </form>

        <Link
          href="/studio"
          className="ms-primary"
          onClick={() => {
            // Save on the way in, so what is on screen is what the studio uses.
            save();
          }}
        >
          {mode === "youcam" && !youcamKey ? "Open studio (uses the server's key)" : "Open studio"}
        </Link>
        <p className="ms-fine">Keys stay in this browser and are sent only to this app&apos;s own server, which passes them to the service. Use a key you can revoke.</p>
      </section>
    </main>
  );
}
