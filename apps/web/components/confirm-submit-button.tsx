"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

/** A submit button that asks first. For the one-click actions that cannot be
 *  taken back and affect somebody else -- ending a person's sessions and mailing
 *  them a new password, say. */
export function ConfirmSubmitButton({
  message,
  ...props
}: { message: string } & Omit<ComponentProps<typeof Button>, "type">) {
  return (
    <Button
      type="submit"
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
      {...props}
    />
  );
}
