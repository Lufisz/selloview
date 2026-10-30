import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../../server/accounts/accounts.mjs';
import { DeliveryError } from '../../server/accounts/mail-transport.mjs';
import { PrivateDatabaseError } from '../../server/accounts/private-database.mjs';
import { CodedError } from '../../server/errors.mjs';
import { RequestRejection } from '../../server/http/guards.mjs';
import { MetricsError } from '../../server/metrics.mjs';
import { ShopifyError } from '../../server/shopify/shop-data.mjs';

test('a coded error carries a stable code, which is also its message unless one is given', () => {
  class SampleError extends CodedError {}

  const plain = new SampleError('bad_thing');
  assert.equal(plain.code, 'bad_thing');
  assert.equal(plain.message, 'bad_thing');
  assert.equal(plain.name, 'SampleError');
  assert.ok(plain instanceof Error);

  assert.equal(new SampleError('bad_thing', 'readable detail').message, 'readable detail');
});

test('every server error class is a coded error that keeps its own name', () => {
  const classes = [AccountError, DeliveryError, MetricsError, PrivateDatabaseError, ShopifyError];
  for (const ErrorClass of classes) {
    const error = new ErrorClass('some_code');
    assert.ok(error instanceof CodedError, ErrorClass.name);
    assert.equal(error.name, ErrorClass.name);
    assert.equal(error.code, 'some_code');
  }

  const rejection = new RequestRejection(413, 'body_too_large');
  assert.ok(rejection instanceof CodedError);
  assert.equal(rejection.name, 'RequestRejection');
  assert.equal(rejection.status, 413);
  assert.equal(rejection.code, 'body_too_large');
});
