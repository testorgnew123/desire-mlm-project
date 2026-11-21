"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** The sign-in button. It says "Signing in…" and stays down as soon as the form is
 *  submitted, so a wait (a function that is waking, a password check, a redirect) does
 *  not look like nothing happened, and a second tap cannot send it twice.
 *
 *  It listens for the form's own submit event: a button that disables itself in its
 *  click handler is not submitted by the browser. It does not use useFormStatus, which
 *  never settled on a form whose action redirects in this app (PROGRESS.md, form
 *  pending state). The page gives it a new `key` on every server render, so a refused
 *  sign-in (a redirect back to this same page) comes back with a fresh button. */
export function SignInButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = () => setSigningIn(true);
    // A page restored from the back/forward cache comes back as it was left.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setSigningIn(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  return (
    <Button ref={ref} type="submit" className="w-full" disabled={signingIn}>
      {signingIn ? "Signing in…" : "Sign in"}
    </Button>
  );
}
