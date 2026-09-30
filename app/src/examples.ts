import { listExamples, type ExampleInfo } from "./ipc";

// File > Open Example…: the chooser for the example projects the application
// ships.
//
// A native <dialog>, like the About box, for the same reasons: Escape-to-close
// and focus trapping come for free, and the styling stays inside our own
// stylesheet instead of following a system theme. No framework and no new
// dependency.
//
// The catalog is the backend's. Nothing here knows which examples exist, what
// they are called or where they live - the list is whatever `list_examples`
// returns, and an example travels back as its id alone. So the two halves cannot
// drift, and the chooser cannot ask for anything the catalog does not contain.
//
// Every piece of that backend-provided text is written with textContent (and
// setAttribute for the per-example button labels), never interpolated into
// innerHTML. The static shell below is the only markup, and it carries no data.

/** What the chooser needs of the app. One line each where it is constructed. */
export interface ExampleHost {
  // Opens the chosen example, materialising its working copy first. Rejects with
  // something worth showing if the example could not be prepared; resolving means
  // the chooser has nothing left to say, whether the project was opened or the
  // request was superseded by a newer one.
  open(id: string): Promise<void>;
}

let dialog: HTMLDialogElement | null = null;
// True from the moment an Open button is activated until its preparation
// settles. Copying an example's files is an await, and a second Open during it
// would race the first for the project. The buttons are disabled as well; this is
// the guard that holds, since a button's disabled state is a rendering decision
// and this is not.
let preparing = false;

function build(): HTMLDialogElement {
  const el = document.createElement("dialog");
  el.className = "example-dialog";
  el.id = "example-dialog";
  el.setAttribute("aria-labelledby", "examples-title");
  el.innerHTML = `
    <h1 id="examples-title" class="examples-title">Open Example</h1>
    <p class="examples-note">
      Quipu copies the example into your own working copy the first time you open it,
      and keeps your changes the next time. The packaged original is never edited.
    </p>
    <p class="examples-error" id="example-error" hidden></p>
    <ul class="examples-list" id="example-list">
      <li class="examples-loading">Loading…</li>
    </ul>
    <div class="examples-actions">
      <button type="button" id="examples-close">Close</button>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector<HTMLButtonElement>("#examples-close")!.addEventListener("click", () => el.close());
  return el;
}

/** Opens the chooser, listing the catalog the backend reports. */
export async function showExamples(host: ExampleHost): Promise<void> {
  const el = (dialog ??= build());
  if (!el.open) el.showModal();
  // Whatever the last visit left behind belongs to that visit.
  clearError(el);
  const listEl = el.querySelector<HTMLElement>("#example-list")!;
  let catalog: ExampleInfo[];
  try {
    catalog = await listExamples();
  } catch (err) {
    listEl.replaceChildren();
    report(el, `Could not read the example catalog. ${String(err)}`);
    return;
  }
  listEl.replaceChildren(...catalog.map((example) => row(el, host, example)));
  // The list arrives after showModal(), so `autofocus` in the markup would have
  // nothing to act on: the first Open button is focused here instead, once it
  // exists. Only when the chooser is the dialog on screen - a slow catalog read
  // must not steal focus back from whatever the user moved on to.
  if (el.open) listEl.querySelector<HTMLButtonElement>("button")?.focus();
}

// One example: its name and description as the catalog spells them, and the
// single button that opens it.
function row(el: HTMLDialogElement, host: ExampleHost, example: ExampleInfo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "example";

  const text = document.createElement("div");
  text.className = "example-text";
  const name = document.createElement("h2");
  name.className = "example-name";
  name.textContent = example.name;
  const desc = document.createElement("p");
  desc.className = "example-desc";
  desc.textContent = example.description;
  text.append(name, desc);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = "Open";
  // "Open" three times over says nothing on its own: the accessible name has to
  // carry which example it opens.
  button.setAttribute("aria-label", `Open ${example.name}`);
  button.addEventListener("click", () => void choose(el, host, example));

  item.append(text, button);
  return item;
}

// Hands one example to the host and reports what came back.
async function choose(el: HTMLDialogElement, host: ExampleHost, example: ExampleInfo) {
  if (preparing) return;
  preparing = true;
  clearError(el);
  setButtonsDisabled(el, true);
  try {
    await host.open(example.id);
    // The project is open (or a newer request has taken over): either way this
    // chooser is done. Guarded because Escape may have closed it already.
    if (el.open) el.close();
  } catch (err) {
    // The example did not open and the project that was open is untouched, so the
    // failure belongs here rather than in that project's Problems pane.
    report(el, `Could not open ${example.name}. ${String(err)}`);
  } finally {
    preparing = false;
    setButtonsDisabled(el, false);
  }
}

function setButtonsDisabled(el: HTMLDialogElement, disabled: boolean) {
  for (const button of el.querySelectorAll<HTMLButtonElement>("#example-list button")) {
    button.disabled = disabled;
  }
}

function clearError(el: HTMLDialogElement) {
  const errorEl = el.querySelector<HTMLElement>("#example-error")!;
  errorEl.textContent = "";
  errorEl.hidden = true;
}

function report(el: HTMLDialogElement, message: string) {
  const errorEl = el.querySelector<HTMLElement>("#example-error")!;
  errorEl.textContent = message;
  errorEl.hidden = false;
  console.error("examples:", message);
  // Dismissed while the copy was still running, so the chooser is not on screen
  // for the message to be read in. The example did not open, which is worth
  // saying once rather than swallowing; it changes nothing about the project the
  // user is looking at.
  if (!el.open) alert(message);
}
