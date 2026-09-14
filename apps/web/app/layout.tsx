import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ServiceWorkerRegister } from "./sw-register";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Desire",
  description: "Real estate sales & commission platform",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <body>
        {/* attribute="class" matches globals.css's `.dark` selector. The CSS
            was already there (Phase 5 or earlier) with nothing to switch it --
            this is that switch. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {/* Required by shadcn's sidebar (icon-only collapsed state uses
              SidebarMenuButton's tooltip), added in Slice 2. */}
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
