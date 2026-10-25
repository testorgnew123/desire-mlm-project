import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { getLandingPath } from "@/lib/landing";
import { getSession } from "@/lib/session";

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  redirect(await getLandingPath(getPrismaClient(), session.user.id));
}
