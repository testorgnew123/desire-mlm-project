// Where next.config.ts rewrites every API and job path of a switched-off
// feature (lib/features.ts). One 404 problem+json for every method, so a client
// that guessed a URL learns the feature is off rather than that it was mistyped.
export const dynamic = "force-dynamic";

function disabled(request: Request): Response {
  return Response.json(
    {
      type: "https://docs.internal/errors/feature-disabled",
      title: "Feature disabled",
      status: 404,
      detail: "This feature is switched off.",
      instance: new URL(request.url).pathname,
    },
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

export { disabled as GET, disabled as POST, disabled as PUT, disabled as PATCH, disabled as DELETE };
