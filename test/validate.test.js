const test = require('node:test'), assert = require('node:assert/strict');
const V = require('../public/validate.js');

test('name rules', () => {
  assert.equal(V.name('  Ayushi   Shukla ').v, 'Ayushi Shukla');
  assert.equal(V.name("Anne-Marie O'Neil Jr.").v, "Anne-Marie O'Neil Jr.");
  assert.equal(V.name('आयुषी शुक्ला').v, 'आयुषी शुक्ला');
  for (const bad of ['', ' ', 'A', 'x'.repeat(51), '<script>alert(1)</script>', '1abc', '@@', null, undefined, 42, {}, ['a']])
    assert.ok(V.name(bad).err, 'should reject ' + JSON.stringify(bad));
});
test('email rules', () => {
  assert.equal(V.email('  Ayushi.S+test@Gmail.COM ').v, 'ayushi.s+test@gmail.com');
  for (const ok of ['a@b.co', 'x_y@mail.example.org', 'n@sub.domain.in']) assert.ok(V.email(ok).v, ok);
  for (const bad of ['', 'abc', 'a@b', 'a@b.', '@b.com', 'a b@c.com', 'a@@b.com', 'a..b@c.com', 'a@b..com', 'a@b.c', 'x'.repeat(250) + '@a.com', null, 5, {}])
    assert.ok(V.email(bad).err, 'should reject ' + JSON.stringify(bad));
});
test('password rules', () => {
  for (const ok of ['blue7Sky9', 'Str0ngPass!', 'पासवर्ड123x', 'a'.repeat(71) + '1']) assert.ok(V.password(ok).v, ok);
  for (const bad of ['', 'short1', 'onlyletters', '12345678', 'a'.repeat(73) + '1', 'password123', 'Password123', null, 12345678, {}])
    assert.ok(V.password(bad).err, 'should reject ' + JSON.stringify(bad));
  assert.ok(V.password('é'.repeat(40) + '1').err, '72-byte bcrypt limit counts bytes');
});
test('strength meter is monotonic-ish', () => {
  assert.ok(V.strength('abc') <= 1); assert.ok(V.strength('blue7sky9') <= 2); assert.equal(V.strength('Str0ng-Passw0rd!'), 4);
});
test('register() collects every error', () => {
  const r = V.register({ name: '', email: 'bad', password: '1' });
  assert.equal(r.ok, false); assert.deepEqual(Object.keys(r.errors).sort(), ['email', 'name', 'password']);
  const g = V.register({ name: ' Ayushi ', email: 'A@B.com', password: 'blue7Sky9x' });
  assert.equal(g.ok, true); assert.deepEqual(g.values, { name: 'Ayushi', email: 'a@b.com', password: 'blue7Sky9x' });
});
test('login() accepts old short passwords but rejects empty / wrong types', () => {
  assert.equal(V.login({ email: 'a@b.com', password: '123456' }).ok, true);
  for (const b of [{}, { email: 'a@b.com' }, { email: 'a@b.com', password: '' }, { email: 5, password: 'x' }, { email: 'a@b.com', password: {} }, { email: 'a@b.com', password: 'x'.repeat(201) }])
    assert.equal(V.login(b).ok, false, JSON.stringify(b));
});
