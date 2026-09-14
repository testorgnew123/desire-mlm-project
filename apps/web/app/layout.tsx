import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
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
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>
        {/* Required by shadcn's sidebar (icon-only collapsed state uses
            SidebarMenuButton's tooltip), added in Slice 2. */}
        <TooltipProvider>{children}</TooltipProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
