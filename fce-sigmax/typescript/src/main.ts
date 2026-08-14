/** Entry point for the TEE extension server. */

import { Server } from "./base/server.js";
import { VERSION } from "./app/config.js";
import { register, reportState, setSignPort } from "./app/handlers.js";
import { startSubscriberWarmer } from "./app/sigmax/handler.js";

const extPort = process.env.EXTENSION_PORT ?? "8080";
const signPort = process.env.SIGN_PORT ?? "9090";

setSignPort(signPort);
const srv = new Server(extPort, signPort, VERSION, register, reportState);
// Warm the subscriber cache from boot so the first signal never cold-scans inside tee-node's
// 2-second action budget. Server-only: never started on module import, so tests stay timer-free.
startSubscriberWarmer();
srv.listenAndServe();
