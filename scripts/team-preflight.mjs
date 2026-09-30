#!/usr/bin/env node
// Reads a Vercel team (JSON from `vercel api /v2/teams/<slug>` on stdin) and
// reports settings that break or limit a workshop identity provider. Prints
// one line per finding: "BLOCK <text>" or "WARN <text>". Exit code 2 when any
// finding blocks the deploy. Read-only; never changes the team.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function preflight(team) {
  const findings = [];
  const block = (text) => findings.push({ level: 'BLOCK', text });
  const warn = (text) => findings.push({ level: 'WARN', text });

  const plan = team?.billing?.plan;
  if (plan === 'hobby') {
    block('The team is on Hobby. The one-minute idle cron and long Sandbox sessions need Pro or Enterprise.');
  }

  // Attendees have no Vercel account and Vercel's SSO calls the discovery
  // document server to server, so the production .vercel.app domain must be public.
  const sso = team?.defaultDeploymentProtection?.ssoProtection?.deploymentType;
  const password = team?.defaultDeploymentProtection?.passwordProtection?.deploymentType;
  if (sso === 'all' || password === 'all') {
    const strict = team?.strictDeploymentProtectionSettings?.enabled;
    block(
      `New projects on this team get Deployment Protection on every domain, including production (${sso === 'all' ? 'Vercel Authentication' : 'Password Protection'}: all).` +
        (strict
          ? ' Strict protection settings are on, so project members may not be able to lower it. Deploy to a different team.'
          : ' Lower the new project to "Standard Protection" before running /setup, or deploy to a different team.'),
    );
  }

  const passport = team?.defaultPassport?.deploymentType;
  if (passport === 'all' || passport === 'all_except_custom_domains') {
    block('The team applies Vercel Passport to new projects by default. The IdP cannot sit behind the Passport protection it supplies. Deploy to a team without a Passport default, or remove Passport from the new project first.');
  }

  if (team?.parentId || team?.orgRootTeamId) {
    warn('The team belongs to a Vercel Organization. Neon Marketplace installs are rejected on Organization child teams today; pass --database-url with a Postgres you control.');
  }

  const expiration = team?.projectExpiration;
  if (expiration?.enabled && expiration?.newProjectsExpireByDefault) {
    warn(`New projects on this team expire automatically (${expiration.defaultExpiration ?? 'default period'}). An expired IdP strands attendees and any team that enforces SSO through it. Extend or disable the project's expiration after deploy if the workshop outlives it.`);
  }

  const production = team?.defaultExpirationSettings?.expirationDaysProduction;
  if (typeof production === 'number' && production < 30) {
    warn(`Production deployments on this team are kept ${production} days. Redeploy (or raise the project's retention) for workshops that run longer.`);
  }

  if (team?.saml?.enforced && team?.saml?.connection?.type && !/pocket/i.test(String(team.saml.connection.type))) {
    warn('This team enforces its own SSO. That is fine for hosting the IdP, but do not use this team as the workshop (attendee) team.');
  }

  return findings;
}

// deploy.sh passes --check. Comparing paths alone is not enough: on macOS the
// temp directory deploy.sh uses sits behind a /var symlink.
const invokedDirectly = process.argv.includes('--check')
  || (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
if (invokedDirectly) {
  let team;
  try {
    team = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    console.log('WARN Could not read the team settings; skipping the preflight check.');
    process.exit(0);
  }
  const findings = preflight(team);
  for (const { level, text } of findings) console.log(`${level} ${text}`);
  process.exit(findings.some((finding) => finding.level === 'BLOCK') ? 2 : 0);
}
