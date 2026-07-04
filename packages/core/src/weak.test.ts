import { describe, it, test } from 'vitest';

describe.skip('parser', () => {
  it.only('parses', () => { expect(1).toBe(1); });
});

xit('disabled', () => {});
xdescribe('disabled suite', () => {});
test.todo('write this later');