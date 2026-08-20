import "dotenv/config";
import { ArtemisApplication } from "./application.js";
import { parseConfig } from "./config.js";

const application = new ArtemisApplication(parseConfig());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    application.stop();
    process.exitCode = 0;
  });
}

application.start().catch(() => {
  application.stop();
  process.exitCode = 1;
});
