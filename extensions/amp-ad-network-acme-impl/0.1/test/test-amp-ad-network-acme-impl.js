/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AmpAdNetworkAcmeImpl} from '../amp-ad-network-acme-impl';
import {
  AmpAdXOriginIframeHandler, // eslint-disable-line no-unused-vars
} from '../../../amp-ad/0.1/amp-ad-xorigin-iframe-handler';
import {base64UrlDecodeToBytes} from '../../../../src/utils/base64';
import {utf8Encode} from '../../../../src/utils/bytes';
import * as sinon from 'sinon';
import {acmeIsA4AEnabled} from '../acme-a4a-config';
import {createElementWithAttributes} from '../../../../src/dom';
import {createIframePromise} from '../../../../testing/iframe';

describe('acme-a4a-config', () => {
  let doc;
  let win;
  beforeEach(() => {
    return createIframePromise().then(f => {
      doc = f.doc;
      win = f.win;
    });
  });
  it('should pass a4a config predicate', () => {
    const element = createElementWithAttributes(doc, 'amp-ad', {
      src: '/ad.html',
      'data-a4a': 'true',
    });
    expect(acmeIsA4AEnabled(win, element)).to.be.true;
  });
  it('should fail a4a config predicate due to missing a4a', () => {
    const element = createElementWithAttributes(doc, 'amp-ad', {
      src: '/ad.html',
    });
    expect(acmeIsA4AEnabled(win, element)).to.be.false;
  });
  it('should fail a4a config predicate due to missing src', () => {
    const element = createElementWithAttributes(doc, 'amp-ad', {
      'data-a4a': 'true',
    });
    expect(acmeIsA4AEnabled(win, element)).to.be.false;
  });
});

describe('amp-ad-network-acme-impl', () => {

  let sandbox;
  let acmeImpl;
  let acmeImplElem;

  beforeEach(() => {
    sandbox = sinon.sandbox.create();
    acmeImplElem = document.createElement('amp-ad');
    acmeImplElem.setAttribute('type', 'acme');
    acmeImplElem.setAttribute('src', '/some_ad.html');
    acmeImplElem.setAttribute('data-a4a','true');
    sandbox.stub(AmpAdNetworkAcmeImpl.prototype, 'getSigningServiceNames',
      () => {
        return ['cloudflare','cloudflare-dev'];
      });
    acmeImpl = new AmpAdNetworkAcmeImpl(acmeImplElem);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('#isValidElement', () => {
    it('should be valid', () => {
      expect(acmeImpl.isValidElement()).to.be.true;
    });
    it('should NOT be valid (impl tag name)', () => {
      acmeImplElem =
document.createElement('amp-ad-network-acme-impl');
      acmeImplElem.setAttribute('type', 'acme');
      acmeImpl = new AmpAdNetworkAcmeImpl(acmeImplElem);
      expect(acmeImpl.isValidElement()).to.be.false;
    });
  });

  describe('#getAdUrl', () => {
    it('should be valid', () => {
      expect(acmeImpl.getAdUrl()).to.equal(
'http://www.acme.com/_a4a/some_ad.html');
    });
  });

  describe('#extractCreativeAndSignature', () => {
    it('without signature', () => {
      return utf8Encode('some creative').then(creative => {
        return expect(acmeImpl.extractCreativeAndSignature(
          creative,
          {
            get: function() { return undefined; },
            has: function() { return false; },
          })).to.eventually.deep.equal(
            {creative, signature: null}
          );
      });
    });
    it('with signature', () => {
      return utf8Encode('some creative').then(creative => {
        return expect(acmeImpl.extractCreativeAndSignature(
          creative,
          {
            get: function(name) {
              return name == 'X-AmpAdSignature' ? 'AQAB' : undefined;
            },
            has: function(name) {
              return name === 'X-AmpAdSignature';
            },
          })).to.eventually.deep.equal(
            {creative, signature: base64UrlDecodeToBytes('AQAB')}
          );
      });
    });
  });
});
