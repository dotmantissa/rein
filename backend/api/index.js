// Vercel serverless entrypoint. The Express app is defined in src/server.js,
// which skips app.listen() when running on Vercel and exports the handler
// instead, so the same file serves both `npm start` and this function.
export { default } from "../src/server.js";
