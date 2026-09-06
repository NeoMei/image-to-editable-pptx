#!/usr/bin/env node

const command = process.argv.slice(2).join(" ");
if (command === "access endpoints --json") {
  // A valid local CLI can take longer than the former 15-second deadline.
  setTimeout(() => {
    console.log(JSON.stringify({ baseUrl: "http://127.0.0.1:10100/v1" }));
  }, 16_000);
} else {
  process.exitCode = 1;
}
