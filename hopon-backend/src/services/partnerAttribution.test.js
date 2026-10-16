'use strict';
jest.mock('../db/pool', () => ({ db: { query: jest.fn() } }));
const { validCode, validSource, calculateCommission } = require('./partnerAttribution');
test('normalise un code partenaire sûr', () => { expect(validCode(' vtc-test-123 ')).toBe('VTC-TEST-123'); expect(validCode('!')).toBeNull(); });
test('refuse une source inventée', () => { expect(validSource('qr_vehicle')).toBe('qr_vehicle'); expect(validSource('evil')).toBe('link'); });
test('calcule une commission en pourcentage ou fixe', () => {
  expect(calculateCommission({commission_type:'percentage',commission_pct:12},19.99)).toBe(2.4);
  expect(calculateCommission({commission_type:'fixed',commission_fixed:3},19.99)).toBe(3);
});
