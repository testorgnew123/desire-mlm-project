"use client";

import { LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "@/lib/sign-out-action";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Replaces the raw name/email text block that used to sit in the sidebar
 *  footer with nothing to click on -- there was no sign-out anywhere in the
 *  app before this (see lib/sign-out-action.ts).
 *
 *  `compact` renders an avatar-only trigger for the PWA's 48px header, where
 *  the sidebar-footer layout (full width, name and email beside the avatar)
 *  does not fit. Deliberately a prop rather than a second component: the
 *  sign-out wiring below revokes the session ROW, not just the cookie, and
 *  that is not something to have two copies of. Both shells still show the
 *  email inside the dropdown. */
export function UserMenu({
  name,
  email,
  compact = false,
}: {
  name: string;
  email: string;
  compact?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          compact ? (
            <button
              type="button"
              aria-label={`Account menu for ${name}`}
              className="flex size-9 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <Avatar size="sm">
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
            </button>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent"
            >
              <Avatar size="sm">
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{email}</span>
              </span>
            </button>
          )
        }
      />
      <DropdownMenuContent align={compact ? "end" : "start"} className="w-56">
        <DropdownMenuGroup>
          {/* The sidebar trigger already shows both, so it only needs the
              email here. The compact trigger shows neither, so who you are
              signed in as has to appear somewhere. */}
          <DropdownMenuLabel>
            {compact ? (
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
              </span>
            ) : (
              email
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={() => signOutAction()}>
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
