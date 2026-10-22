import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pad, toHex } from 'viem';
import { canManage, decodeRoles, describeArgument } from '../../src/roles.js';

const SET_ADDRESS = 1n << 0n;
const SET_TEXT = 1n << 4n;
const LINK = 1n << 28n;
const CAN_NAME = 1n << 120n;
const UPGRADE = 1n << 124n;
const admin = (role: bigint) => role << 128n;

describe('roles', () => {
  it('decodes roles and admin roles', () => {
    const d = decodeRoles(SET_TEXT | LINK | UPGRADE | admin(SET_TEXT));
    assert.deepEqual(d.roles, ['set_text', 'link', 'upgrade']);
    assert.deepEqual(d.admin_roles, ['set_text']);
    assert.equal(d.role_bitmap, `0x${(SET_TEXT | LINK | UPGRADE | admin(SET_TEXT)).toString(16)}`);
  });

  it('the namer role alone does not make a manager', () => {
    assert.equal(canManage(CAN_NAME | admin(CAN_NAME)), false);
    assert.equal(canManage(CAN_NAME | SET_TEXT), true);
    assert.equal(canManage(admin(LINK)), true);
  });

  it('describes per-key grant arguments', () => {
    assert.deepEqual(describeArgument(toHex('com.twitter'), ['set_text']), { key: 'com.twitter' });
    assert.deepEqual(describeArgument(pad(toHex(60n), { size: 32 }), ['set_address']), { coin_type: '60' });
    assert.deepEqual(describeArgument('0x01ffc9a7', ['set_interface']), { interface_id: '0x01ffc9a7' });
    assert.deepEqual(describeArgument('0xff', ['set_text']), {}); // not UTF-8
  });
});
