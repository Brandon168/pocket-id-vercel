import { Sandbox } from '@vercel/sandbox';

// sandbox-down.mjs — stop + delete a workshop sandbox.
// Usage: node sandbox-down.mjs --name <sandbox-name>
// The sandbox filesystem snapshot survives deletion until it expires; the
// DATABASE (attendee PII) is separate — drop it yourself (Neon branch delete
// or `DROP DATABASE`), same as teardown.sh does for the Function path.
const args = process.argv.slice(2);
const i = args.indexOf('--name');
if (i < 0 || !args[i + 1]) {
  console.error('usage: node sandbox-down.mjs --name <sandbox-name>');
  process.exit(2);
}
const sbx = await Sandbox.get({ name: args[i + 1] });
console.log('stopping', sbx.name, '(was', sbx.status + ')');
await sbx.stop();
await sbx.delete();
console.log('deleted. Remember to drop the workshop database.');
process.exit(0);
