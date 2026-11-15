"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

interface FormState {
  /** No second submit while this is true. */
  locked: boolean;
  /** The request is in flight: the button says it is working. */
  busy: boolean;
  /** Which `name="intent"` button was pressed, if the form has several. */
  intent: string | null;
}

const FormStateContext = createContext<FormState>({ locked: false, busy: false, intent: null });

/** How long after the server has answered a save the screen may stay unchanged
 *  before the page is reloaded. Normally the refreshed page paints within a few
 *  hundred ms of the answer, so this never fires. It exists because the
 *  production build of the app intermittently does not paint the answer at all:
 *  the POST returns 200 with the new rows in it and the router keeps the old
 *  screen (and keeps the transition pending) for good. Measured on `next start`
 *  with a local database (answers in ~40 ms): about 7 saves in 10 on the project
 *  page; never on `next dev`; and with 150 ms or more of network latency, 16
 *  saves in 16 painted normally. The cause was not found (it is not staleTimes,
 *  link prefetch, the form mechanism or any one input). A reload is the one
 *  recovery that always shows the saved data. */
const RECOVER_AFTER_MS = 600;

/** The same recovery for a save that moves to another page. That navigation
 *  fetches the next page first, which on the live site is a full ~0.5 s round
 *  trip before anything can paint, so it gets longer before the page is
 *  navigated to by hand. */
const RECOVER_NAVIGATION_AFTER_MS = 3000;

const CARRY_PREFIX = "action-form:";

type Run = (formData: FormData) => Promise<ActionResult>;

/** A form that runs a Server Action from its own submit handler and shows what
 *  happened: the button says "Saving..." and is disabled while the request is in
 *  flight (so a second click cannot submit twice), and a refusal appears under the
 *  form with the typed values still in place.
 *
 *  Why not `<form action={serverAction}>`: that path gave no feedback at all, and
 *  in the production build it left the page showing the old data after a save
 *  (see lib/action-result.ts). Why not useFormStatus: it only works with a form
 *  `action`, and a redirecting action under it hung -- an earlier attempt here
 *  was reverted for that reason.
 *
 *  The action is expected to call revalidatePath itself; the refreshed page then
 *  arrives in the same response and is applied inside this transition.
 *
 *  One form, several buttons: pass `actions` and give each SubmitButton
 *  `name="intent" value="<key>"`; the button pressed picks the action. */
export function ActionForm({
  action,
  actions,
  children,
  className,
  resetOnSuccess = true,
  feedback = "bottom",
  id,
}: {
  /** What the form runs; the default when no `intent` button was pressed. */
  action?: Run;
  actions?: Record<string, Run>;
  children: ReactNode;
  className?: string;
  /** Clear the typed values after a success. Off for a form whose fields are
   *  React state rather than plain inputs. */
  resetOnSuccess?: boolean;
  /** Where the message sits: under the form (default) or above it, for a form
   *  that is mostly a long table. */
  feedback?: "top" | "bottom";
  /** Gives the form a name that survives the recovery reload: a success message
   *  would otherwise vanish with the page. Unique per page. */
  id?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<string | null>(null);
  const [released, setReleased] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  // The COMMITTED value of `pending`, written in an effect and not during render:
  // a render of the stalled transition can see `pending` already false without
  // ever being committed, and a watchdog that read that value would conclude the
  // screen had painted when it had not (seen on the create-user form).
  const pendingRef = useRef(false);
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `released`: a save that carried a one-time secret is never reloaded away, so
  // once the paint window has passed the form is usable again instead of waiting
  // for a transition that may never end.
  const locked = busy || (pending && !released);

  // The refreshed page arrived and painted: the transition has ended, nothing to recover.
  useEffect(() => {
    pendingRef.current = pending;
    if (!pending && recoverTimer.current !== null) {
      clearTimeout(recoverTimer.current);
      recoverTimer.current = null;
    }
  }, [pending]);
  useEffect(
    () => () => {
      if (recoverTimer.current !== null) clearTimeout(recoverTimer.current);
    },
    [],
  );

  // A message saved just before a recovery reload.
  useEffect(() => {
    if (!id) return;
    try {
      const raw = sessionStorage.getItem(CARRY_PREFIX + id);
      if (!raw) return;
      sessionStorage.removeItem(CARRY_PREFIX + id);
      const saved = JSON.parse(raw) as { message?: string };
      if (saved.message) setResult({ ok: true, message: saved.message });
    } catch {
      // Storage unavailable: the message is simply not carried over.
    }
  }, [id]);

  function afterSuccess(next: Extract<ActionResult, { ok: true }>) {
    if (resetOnSuccess) formRef.current?.reset();
    const target = next.redirectTo;
    if (target) router.push(target);
    recoverTimer.current = setTimeout(
      () => {
        if (!pendingRef.current) return;
        if (next.secret) {
          setReleased(true);
          return;
        }
        if (target) {
          window.location.assign(target);
          return;
        }
        if (id && next.message) {
          try {
            sessionStorage.setItem(CARRY_PREFIX + id, JSON.stringify({ message: next.message }));
          } catch {
            // Storage unavailable: the message is lost with the reload; the data is not.
          }
        }
        window.location.reload();
      },
      target ? RECOVER_NAVIGATION_AFTER_MS : RECOVER_AFTER_MS,
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const chosen = submitter?.name === "intent" ? submitter.value : null;
    const run = (chosen !== null ? actions?.[chosen] : undefined) ?? action;
    if (!run) {
      setResult({ ok: false, error: "This button has nothing to run." });
      return;
    }
    // Read before anything is disabled: a disabled field is left out of FormData.
    // The pressed button's own name/value is added by hand: the two-argument
    // FormData constructor that does it is missing from older phone browsers.
    const data = new FormData(event.currentTarget);
    if (submitter?.name) data.append(submitter.name, submitter.value);
    setResult(null);
    setIntent(chosen);
    setReleased(false);
    setBusy(true);
    startTransition(async () => {
      try {
        const next = await run(data);
        setBusy(false);
        setResult(next);
        if (next.ok) afterSuccess(next);
      } catch (error) {
        setBusy(false);
        setResult({
          ok: false,
          error: error instanceof Error ? error.message : "Something went wrong. Try again.",
        });
      }
    });
  }

  const feedbackNode = (
    <>
      {result && !result.ok ? (
        <p role="alert" className="text-sm text-danger">
          {result.error}
        </p>
      ) : null}
      {result?.ok && (result.message || result.secret) ? (
        <p role="status" className="text-sm text-success">
          {result.message}
          {result.secret ? (
            <>
              {" "}
              <code className="font-mono font-semibold">{result.secret}</code>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );

  return (
    <FormStateContext.Provider value={{ locked, busy, intent }}>
      <form ref={formRef} onSubmit={onSubmit} className={className} aria-busy={locked}>
        {feedback === "top" ? feedbackNode : null}
        {children}
        {feedback === "bottom" ? feedbackNode : null}
      </form>
    </FormStateContext.Provider>
  );
}

/** The submit button of an ActionForm: disabled, with `pendingLabel`, while the
 *  action runs. With `confirm` it asks first and does nothing if the answer is no
 *  -- for the one-click actions that cannot be taken back. In a form with several
 *  `intent` buttons only the one pressed shows `pendingLabel`. */
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  disabled,
  confirm,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Button>, "type"> & { pendingLabel?: string; confirm?: string }) {
  const { locked, busy, intent } = useContext(FormStateContext);
  const mine = intent === null || String(props.value ?? "") === intent;
  return (
    <Button
      type="submit"
      disabled={locked || disabled}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {busy && mine ? pendingLabel : children}
    </Button>
  );
}
