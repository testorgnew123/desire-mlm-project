// Throwaway SMTP sink for trying mail locally: speaks just enough SMTP for nodemailer,
// keeps the messages in memory and accepts anything. An optional reply delay stands in
// for the round trip to a real mail provider. Local only.
//
//   node apps/web/scripts/smtp-sink.mjs     smtp 127.0.0.1:2525, control http 127.0.0.1:2526
//   run the app with SMTP_HOST=127.0.0.1 SMTP_PORT=2525 MAIL_FROM=noreply@desire.test
//   GET /delay?ms=150             delay before every reply
//   GET /last?to=<address>        text of the latest message to that address
//   GET /count                    messages received so far
import net from "node:net";
import http from "node:http";

let delayMs = Number(process.env.SINK_DELAY_MS ?? 0);
const messages = [];

const reply = (socket, text) => setTimeout(() => socket.writable && socket.write(`${text}\r\n`), delayMs);

net
  .createServer((socket) => {
    let inData = false;
    let buffer = "";
    let recipients = [];
    reply(socket, "220 mail-sink ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          messages.push({ to: recipients.join(","), at: Date.now(), text: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          recipients = [];
          reply(socket, "250 2.0.0 queued");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === "EHLO" || command === "HELO") reply(socket, "250-mail-sink\r\n250 8BITMIME");
        else if (command === "MAIL") reply(socket, "250 2.1.0 ok");
        else if (command === "RCPT") {
          recipients.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, "$1"));
          reply(socket, "250 2.1.5 ok");
        } else if (command === "DATA") {
          inData = true;
          reply(socket, "354 go ahead");
        } else if (command === "RSET" || command === "NOOP") reply(socket, "250 ok");
        else if (command === "QUIT") {
          reply(socket, "221 bye");
          setTimeout(() => socket.end(), delayMs + 5);
        } else reply(socket, "502 not implemented");
      }
    });
    socket.on("error", () => {});
  })
  .listen(2525, "127.0.0.1");

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://sink");
    if (url.pathname === "/delay") {
      delayMs = Number(url.searchParams.get("ms") ?? 0);
      res.end(`delay=${delayMs}`);
    } else if (url.pathname === "/last") {
      const to = (url.searchParams.get("to") ?? "").toLowerCase();
      const found = [...messages].reverse().find((m) => to === "" || m.to.toLowerCase().includes(to));
      res.statusCode = found ? 200 : 404;
      res.end(found ? found.text : "");
    } else if (url.pathname === "/count") {
      res.end(String(messages.length));
    } else {
      res.statusCode = 404;
      res.end();
    }
  })
  .listen(2526, "127.0.0.1");

console.log("sink up: smtp 2525, control http 2526");
