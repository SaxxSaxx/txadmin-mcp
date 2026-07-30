import { describe, it, expect } from 'vitest';
import { selectTools } from '../src/tools/registry.js';
import type { ToolDef } from '../src/tools/types.js';
import type { Mode } from '../src/config.js';

const def = (name: string, tier: Mode, permission: string | null): ToolDef => ({
  name,
  tier,
  permission,
  description: '',
  inputSchema: {},
  readOnly: true,
  destructive: false,
  run: async () => '',
});

const defs = [
  def('r_open', 'read', null),
  def('r_console', 'read', 'console.view'),
  def('w_announce', 'write', 'announcement'),
  def('a_ban', 'admin', 'players.ban'),
];

const admin = (permissions: string[], isMaster = false) => ({ name: 'x', permissions, isMaster });

describe('selectTools', () => {
  it('read mode exposes only read-tier tools', () => {
    const got = selectTools(defs, 'read', admin(['all_permissions'])).map((d) => d.name);
    expect(got).toEqual(['r_open', 'r_console']);
  });

  it('write mode includes read tools', () => {
    const got = selectTools(defs, 'write', admin(['all_permissions'])).map((d) => d.name);
    expect(got).toEqual(['r_open', 'r_console', 'w_announce']);
  });

  it('tiers are cumulative up to admin', () => {
    const got = selectTools(defs, 'admin', admin(['all_permissions'])).map((d) => d.name);
    expect(got).toEqual(['r_open', 'r_console', 'w_announce', 'a_ban']);
  });

  it('hides tools the account lacks permission for', () => {
    const got = selectTools(defs, 'admin', admin(['announcement'])).map((d) => d.name);
    expect(got).toEqual(['r_open', 'w_announce']);
  });

  it('a null permission is always allowed', () => {
    expect(selectTools(defs, 'read', admin([])).map((d) => d.name)).toEqual(['r_open']);
  });

  it('isMaster passes every permission gate', () => {
    expect(selectTools(defs, 'admin', admin([], true))).toHaveLength(4);
  });
});
