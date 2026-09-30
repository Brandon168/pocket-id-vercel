import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error: plain ESM script without type declarations.
import { preflight } from '../scripts/team-preflight.mjs';

// Shapes taken from real `vercel api /v2/teams/<slug>` responses (2026-09-30), trimmed.
const standalonePro = { billing: { plan: 'enterprise' }, defaultDeploymentProtection: { ssoProtection: { deploymentType: 'all_except_custom_domains' } } };
const allDomainsProtected = {
  billing: { plan: 'enterprise' }, parentId: 'org_x', orgRootTeamId: 'team_root',
  defaultDeploymentProtection: { ssoProtection: { deploymentType: 'all' } },
  strictDeploymentProtectionSettings: { enabled: true },
  defaultExpirationSettings: { expirationDaysProduction: 14 },
};
const passportDefault = { billing: { plan: 'enterprise' }, defaultPassport: { connectorId: 'scl_x', deploymentType: 'all' } };
const expiringProjects = { billing: { plan: 'enterprise' }, projectExpiration: { enabled: true, defaultExpiration: '1-month', newProjectsExpireByDefault: true } };

const levels = (team: unknown) => (preflight(team) as Array<{ level: string; text: string }>).map(f => f.level);

it('passes a standalone team with standard protection', () => {
  expect(preflight(standalonePro)).toEqual([]);
});

it('blocks teams that protect production domains or apply Passport to new projects', () => {
  expect(levels(allDomainsProtected)).toEqual(['BLOCK', 'WARN']);
  expect(preflight(allDomainsProtected)[0].text).toMatch(/Strict protection settings are on/);
  expect(levels(passportDefault)).toEqual(['BLOCK']);
  expect(levels({ billing: { plan: 'hobby' } })).toEqual(['BLOCK']);
});

it('warns about automatic project expiry', () => {
  expect(levels(expiringProjects)).toEqual(['WARN']);
  expect(preflight(expiringProjects)[0].text).toMatch(/1-month/);
});

it('exits 2 on a block when deploy.sh runs it from a temporary copy', () => {
  // deploy.sh copies the template to mktemp; on macOS that path is behind a symlink.
  const work = mkdtempSync(join(tmpdir(), 'preflight-'));
  try {
    cpSync(join(__dirname, '..', 'scripts'), join(work, 'scripts'), { recursive: true });
    const run = (team: unknown) => spawnSync('node', [join(work, 'scripts/team-preflight.mjs'), '--check'], { input: JSON.stringify(team) });
    expect(run(passportDefault).status).toBe(2);
    expect(run(expiringProjects).status).toBe(0);
    expect(execFileSync('node', [join(work, 'scripts/team-preflight.mjs'), '--check'], { input: 'not json' }).toString()).toMatch(/^WARN Could not read/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
