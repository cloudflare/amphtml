/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
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

import {FetchMock, networkFailure} from './fetch-mock';
import {MockA4AImpl, TEST_URL} from './utils';
import {createIframePromise} from '../../../../testing/iframe';
import {
  AmpA4A,
  RENDERING_TYPE_HEADER,
  DEFAULT_SAFEFRAME_VERSION,
  SAFEFRAME_VERSION_HEADER,
  protectFunctionWrapper,
  assignAdUrlToError,
} from '../amp-a4a';
import {
  AMP_SIGNATURE_HEADER,
  LEGACY_VERIFIER_EID,
  NEW_VERIFIER_EID,
  VERIFIER_EXP_NAME,
  signatureVerifierFor,
} from '../legacy-signature-verifier';
import {VerificationStatus} from '../signature-verifier';
import {FriendlyIframeEmbed} from '../../../../src/friendly-iframe-embed';
import {utf8EncodeSync} from '../../../../src/utils/bytes';
import {Signals} from '../../../../src/utils/signals';
import {Extensions} from '../../../../src/service/extensions-impl';
import {Viewer} from '../../../../src/service/viewer-impl';
import {cancellation} from '../../../../src/error';
import {forceExperimentBranch} from '../../../../src/experiments';
import {
  data as validCSSAmp,
} from './testdata/valid_css_at_rules_amp.reserialized';
import {data as testFragments} from './testdata/test_fragments';
import {resetScheduledElementForTesting} from '../../../../src/custom-element';
import {Services} from '../../../../src/services';
import {incrementLoadingAds} from '../../../amp-ad/0.1/concurrent-load';
import '../../../../extensions/amp-ad/0.1/amp-ad-xorigin-iframe-handler';
import {dev, user} from '../../../../src/log';
import {createElementWithAttributes} from '../../../../src/dom';
import {layoutRectLtwh} from '../../../../src/layout-rect';
import {installDocService} from '../../../../src/service/ampdoc-impl';
import * as sinon from 'sinon';
// Need the following side-effect import because in actual production code,
// Fast Fetch impls are always loaded via an AmpAd tag, which means AmpAd is
// always available for them. However, when we test an impl in isolation,
// AmpAd is not loaded already, so we need to load it separately.
import '../../../amp-ad/0.1/amp-ad';

describe('amp-a4a', () => {
  let sandbox;
  let fetchMock;
  let getSigningServiceNamesMock;
  let viewerWhenVisibleMock;
  let adResponse;
  let onCreativeRenderSpy;
  let getResourceStub;

  beforeEach(() => {
    sandbox = sinon.sandbox.create();
    fetchMock = null;
    getSigningServiceNamesMock = sandbox.stub(AmpA4A.prototype,
        'getSigningServiceNames');
    onCreativeRenderSpy =
        sandbox.spy(AmpA4A.prototype, 'onCreativeRender');
    getSigningServiceNamesMock.returns(['google']);
    viewerWhenVisibleMock = sandbox.stub(Viewer.prototype, 'whenFirstVisible');
    viewerWhenVisibleMock.returns(Promise.resolve());
    getResourceStub = sandbox.stub(AmpA4A.prototype, 'getResource');
    getResourceStub.returns({
      getUpgradeDelayMs: () => 12345,
    });
    adResponse = {
      headers: {
        'AMP-Access-Control-Allow-Source-Origin': 'about:srcdoc',
        'AMP-Fast-Fetch-Signature': validCSSAmp.signatureHeader,
      },
      body: validCSSAmp.reserialized,
    };
    adResponse.headers[AMP_SIGNATURE_HEADER] = validCSSAmp.signature;
  });

  afterEach(() => {
    if (fetchMock) {
      fetchMock./*OK*/restore();
      fetchMock = null;
    }
    sandbox.restore();
    resetScheduledElementForTesting(window, 'amp-a4a');
  });

  function setupForAdTesting(fixture) {
    expect(fetchMock).to.be.null;
    fetchMock = new FetchMock(fixture.win);
    fetchMock.getOnce(
        'https://cdn.ampproject.org/amp-ad-verifying-keyset.json', {
          body: validCSSAmp.publicKeyset,
          status: 200,
          headers: {'Content-Type': 'application/jwk-set+json'},
        });
    installDocService(fixture.win, /* isSingleDoc */ true);
    const doc = fixture.doc;
    // TODO(a4a-cam@): This is necessary in the short term, until A4A is
    // smarter about host document styling.  The issue is that it needs to
    // inherit the AMP runtime style element in order for shadow DOM-enclosed
    // elements to behave properly.  So we have to set up a minimal one here.
    const ampStyle = doc.createElement('style');
    ampStyle.setAttribute('amp-runtime', 'scratch-fortesting');
    doc.head.appendChild(ampStyle);
  }

  function createA4aElement(doc, opt_rect) {
    const element = createElementWithAttributes(doc, 'amp-a4a', {
      'width': opt_rect ? String(opt_rect.width) : '200',
      'height': opt_rect ? String(opt_rect.height) : '50',
      'type': 'adsense',
    });
    element.getAmpDoc = () => {
      const ampdocService = Services.ampdocServiceFor(doc.defaultView);
      return ampdocService.getAmpDoc(element);
    };
    element.isBuilt = () => {return true;};
    element.getLayoutBox = () => {
      return opt_rect || layoutRectLtwh(0, 0, 200, 50);
    };
    element.getPageLayoutBox = () => {
      return element.getLayoutBox.apply(element, arguments);
    };
    element.getIntersectionChangeEntry = () => {return null;};
    const signals = new Signals();
    element.signals = () => signals;
    element.renderStarted = () => {
      signals.signal('render-start');
    };
    doc.body.appendChild(element);
    return element;
  }

  function buildCreativeString(opt_additionalInfo) {
    const baseTestDoc = testFragments.minimalDocOneStyle;
    const offsets = opt_additionalInfo || {};
    offsets.ampRuntimeUtf16CharOffsets = [
      baseTestDoc.indexOf('<style amp4ads-boilerplate'),
      baseTestDoc.lastIndexOf('</script>') + '</script>'.length,
    ];
    const splicePoint = baseTestDoc.indexOf('</body>');
    return baseTestDoc.slice(0, splicePoint) +
        '<script type="application/json" amp-ad-metadata>' +
        JSON.stringify(offsets) + '</script>' +
        baseTestDoc.slice(splicePoint);
  }

  // Checks that element is an amp-ad that is rendered via A4A.
  function verifyA4ARender(element) {
    expect(element.tagName.toLowerCase()).to.equal('amp-a4a');
    expect(element.querySelectorAll('iframe')).to.have.lengthOf(1);
    expect(element.querySelector('iframe[name]')).to.not.be.ok;
    expect(element.querySelector('iframe[src]')).to.not.be.ok;
    const friendlyChild = element.querySelector('iframe[srcdoc]');
    expect(friendlyChild).to.be.ok;
    expect(friendlyChild.getAttribute('srcdoc')).to.have.string(
        '<html ⚡4ads>');
    expect(element).to.be.visible;
    expect(friendlyChild).to.be.visible;
  }

  // Checks that element is an amp-ad that is rendered via SafeFrame.
  function verifySafeFrameRender(element, sfVersion) {
    expect(element.tagName.toLowerCase()).to.equal('amp-a4a');
    expect(element).to.be.visible;
    expect(element.querySelectorAll('iframe')).to.have.lengthOf(1);
    const safeFrameUrl = 'https://tpc.googlesyndication.com/safeframe/' +
      sfVersion + '/html/container.html';
    const child = element.querySelector(`iframe[src^="${safeFrameUrl}"][name]`);
    expect(child).to.be.ok;
    const name = child.getAttribute('name');
    expect(name).to.match(/[^;]+;\d+;[\s\S]+/);
    const re = /^([^;]+);(\d+);([\s\S]*)$/;
    const match = re.exec(name);
    expect(match).to.be.ok;
    const contentLength = Number(match[2]);
    const rest = match[3];
    expect(rest.length > contentLength).to.be.true;
    const data = JSON.parse(rest.substr(contentLength));
    expect(data).to.be.ok;
    verifyContext(data._context);
  }

  function verifyContext(context) {
    expect(context).to.be.ok;
    expect(context.sentinel).to.be.ok;
    expect(context.sentinel).to.match(/((\d+)-\d+)/);
  }

  // Checks that element is an amp-ad that is rendered via nameframe.
  function verifyNameFrameRender(element) {
    expect(element.tagName.toLowerCase()).to.equal('amp-a4a');
    expect(element).to.be.visible;
    expect(element.querySelectorAll('iframe')).to.have.lengthOf(1);
    const child = element.querySelector('iframe[src][name]');
    expect(child).to.be.ok;
    expect(child.src).to.match(/^https?:[^?#]+nameframe(\.max)?\.html/);
    const nameData = child.getAttribute('name');
    expect(nameData).to.be.ok;
    verifyNameData(nameData);
    expect(child).to.be.visible;
  }

  function verifyCachedContentIframeRender(element, srcUrl) {
    expect(element.tagName.toLowerCase()).to.equal('amp-a4a');
    expect(element).to.be.visible;
    expect(element.querySelectorAll('iframe')).to.have.lengthOf(1);
    const child = element.querySelector('iframe[src]');
    expect(child).to.be.ok;
    expect(child.src).to.have.string(srcUrl);
    const nameData = child.getAttribute('name');
    expect(nameData).to.be.ok;
    verifyNameData(nameData);
    expect(child).to.be.visible;
  }

  function verifyNameData(nameData) {
    let attributes;
    expect(() => {attributes = JSON.parse(nameData);}).not.to.throw(Error);
    expect(attributes).to.be.ok;
    verifyContext(attributes._context);
  }

  describe('ads are visible', () => {
    let a4aElement;
    let a4a;
    let fixture;
    beforeEach(() => createIframePromise().then(f => {
      fixture = f;
      setupForAdTesting(fixture);
      fetchMock.getOnce(
          TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
          {name: 'ad'});
      a4aElement = createA4aElement(fixture.doc);
      a4a = new MockA4AImpl(a4aElement);
      return fixture;
    }));

    it('for SafeFrame rendering case', () => {
      // Make sure there's no signature, so that we go down the 3p iframe path.
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      // If rendering type is safeframe, we SHOULD attach a SafeFrame.
      adResponse.headers[RENDERING_TYPE_HEADER] = 'safeframe';
      a4a.buildCallback();
      const lifecycleEventStub =
          sandbox.stub(a4a, 'protectedEmitLifecycleEvent_');
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        const child = a4aElement.querySelector('iframe[name]');
        expect(child).to.be.ok;
        expect(child).to.be.visible;
        expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
        expect(lifecycleEventStub).to.be.calledWith('renderSafeFrameStart',
            {'isAmpCreative': false, 'releaseType': 'pr'});
      });
    });

    it('for ios defaults to SafeFrame rendering', () => {
      const platform = Services.platformFor(fixture.win);
      sandbox.stub(platform, 'isIos').returns(true);
      a4a = new MockA4AImpl(a4aElement);
      // Make sure there's no signature, so that we go down the 3p iframe path.
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      // Ensure no rendering type header (ios on safari will default to
      // safeframe).
      delete adResponse.headers[RENDERING_TYPE_HEADER];
      fixture.doc.body.appendChild(a4aElement);
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        // Force vsync system to run all queued tasks, so that DOM mutations
        // are actually completed before testing.
        a4a.vsync_.runScheduledTasks_();
        const child = a4aElement.querySelector('iframe[name]');
        expect(child).to.be.ok;
        expect(child).to.be.visible;
        expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
      });
    });

    it('for cached content iframe rendering case', () => {
      // Make sure there's no signature, so that we go down the 3p iframe path.
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        const child = a4aElement.querySelector('iframe[src]');
        expect(child).to.be.ok;
        expect(child).to.be.visible;
        expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
      });
    });

    it('for A4A friendly iframe rendering case with legacy verifier', () => {
      expect(a4a.friendlyIframeEmbed_).to.not.exist;
      forceExperimentBranch(
          fixture.win, VERIFIER_EXP_NAME, LEGACY_VERIFIER_EID);
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        const child = a4aElement.querySelector('iframe[srcdoc]');
        expect(child).to.be.ok;
        expect(child).to.be.visible;
        const a4aBody = child.contentDocument.body;
        expect(a4aBody).to.be.ok;
        expect(a4aBody).to.be.visible;
        expect(a4a.friendlyIframeEmbed_).to.exist;
      });
    });

    it('for A4A friendly iframe rendering case with new verifier', () => {
      expect(a4a.friendlyIframeEmbed_).to.not.exist;
      forceExperimentBranch(fixture.win, VERIFIER_EXP_NAME, NEW_VERIFIER_EID);
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        const child = a4aElement.querySelector('iframe[srcdoc]');
        expect(child).to.be.ok;
        expect(child).to.be.visible;
        const a4aBody = child.contentDocument.body;
        expect(a4aBody).to.be.ok;
        expect(a4aBody).to.be.visible;
        expect(a4a.friendlyIframeEmbed_).to.exist;
      });
    });

    it('for A4A FIE should wait for initial layout', () => {
      let iniLoadResolver;
      const iniLoadPromise = new Promise(resolve => {
        iniLoadResolver = resolve;
      });
      const whenIniLoadedStub = sandbox.stub(
          FriendlyIframeEmbed.prototype,
          'whenIniLoaded',
          () => iniLoadPromise);
      a4a.buildCallback();
      const lifecycleEventStub = sandbox.stub(
          a4a, 'protectedEmitLifecycleEvent_');
      a4a.onLayoutMeasure();
      const layoutPromise = a4a.layoutCallback();
      return Promise.resolve().then(() => {
        expect(whenIniLoadedStub).to.not.be.called;
        iniLoadResolver();
        return layoutPromise;
      }).then(() => {
        expect(a4a.friendlyIframeEmbed_).to.exist;
        expect(a4a.friendlyIframeEmbed_.host).to.equal(a4a.element);
        expect(whenIniLoadedStub).to.be.calledOnce;
        expect(lifecycleEventStub).to.be.calledWith('friendlyIframeIniLoad');
      });
    });

    it('should reset state to null on non-FIE unlayoutCallback', () => {
      // Make sure there's no signature, so that we go down the 3p iframe path.
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        expect(a4aElement.querySelector('iframe[src]')).to.be.ok;
        expect(a4a.unlayoutCallback()).to.be.true;
        expect(a4aElement.querySelector('iframe[src]')).to.not.be.ok;
      });
    });

    it('should not reset state to null on FIE unlayoutCallback', () => {
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        a4a.vsync_.runScheduledTasks_();
        expect(a4a.friendlyIframeEmbed_).to.exist;
        const destroySpy = sandbox.spy();
        a4a.friendlyIframeEmbed_.destroy = destroySpy;
        expect(a4a.unlayoutCallback()).to.be.false;
        expect(a4a.friendlyIframeEmbed_).to.exist;
        expect(destroySpy).to.not.be.called;
      });
    });

    it('should update embed visibility', () => {
      sandbox.stub(a4a, 'isInViewport', () => false);
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      return a4a.layoutCallback().then(() => {
        a4a.vsync_.runScheduledTasks_();
        expect(a4a.friendlyIframeEmbed_).to.exist;
        expect(a4a.friendlyIframeEmbed_.isVisible()).to.be.false;

        a4a.viewportCallback(true);
        expect(a4a.friendlyIframeEmbed_.isVisible()).to.be.true;

        a4a.viewportCallback(false);
        expect(a4a.friendlyIframeEmbed_.isVisible()).to.be.false;

        a4a.viewportCallback(true);
        expect(a4a.friendlyIframeEmbed_.isVisible()).to.be.true;
      });
    });
  });
  describe('layoutCallback cancels properly', () => {
    let a4aElement;
    let a4a;
    let fixture;
    beforeEach(() => createIframePromise().then(f => {
      fixture = f;
      setupForAdTesting(fixture);
      fetchMock.getOnce(
          TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
          {name: 'ad'});
      a4aElement = createA4aElement(fixture.doc);
      a4a = new MockA4AImpl(a4aElement);
      return fixture;
    }));

    it('when unlayoutCallback called after adPromise', () => {
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      let promiseResolver;
      a4a.adPromise_ = new Promise(resolver => {
        promiseResolver = resolver;
      });
      const layoutCallbackPromise = a4a.layoutCallback();
      a4a.unlayoutCallback();
      const renderNonAmpCreativeSpy = sandbox.spy(
          AmpA4A.prototype, 'renderNonAmpCreative_');
      promiseResolver();
      layoutCallbackPromise.then(() => {
        // We should never get in here.
        expect(false).to.be.true;
      }).catch(err => {
        expect(renderNonAmpCreativeSpy).to.not.be.called;
        expect(err).to.be.ok;
        expect(err.message).to.equal('CANCELLED');
      });
    });

    it('when unlayoutCallback called before renderAmpCreative_', () => {
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      let promiseResolver;
      a4a.renderAmpCreative_ = new Promise(resolver => {
        promiseResolver = resolver;
      });
      const layoutCallbackPromise = a4a.layoutCallback();
      a4a.unlayoutCallback();

      promiseResolver();
      layoutCallbackPromise.then(() => {
        // We should never get in here.
        expect(false).to.be.true;
      }).catch(err => {
        expect(err).to.be.ok;
        expect(err.message).to.equal('CANCELLED');
      });
    });
  });

  describe('cross-domain rendering', () => {
    let a4aElement;
    let a4a;
    let lifecycleEventStub;
    beforeEach(() => {
      // Make sure there's no signature, so that we go down the 3p iframe path.
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      // If rendering type is safeframe, we SHOULD attach a SafeFrame.
      adResponse.headers[RENDERING_TYPE_HEADER] = 'safeframe';
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        a4aElement = createA4aElement(doc);
        a4a = new MockA4AImpl(a4aElement);
        a4a.createdCallback();
        a4a.firstAttachedCallback();
        a4a.buildCallback();
        lifecycleEventStub = sandbox.stub(a4a, 'protectedEmitLifecycleEvent_');
        expect(onCreativeRenderSpy).to.not.be.called;
      });
    });

    describe('illegal render mode value', () => {
      let devErrLogSpy;
      beforeEach(() => {
        devErrLogSpy = sandbox.spy(dev(), 'error');
        // If rendering type is unknown, should fall back to cached content
        // iframe and generate an error.
        adResponse.headers[RENDERING_TYPE_HEADER] = 'random illegal value';
        a4a.onLayoutMeasure();
      });

      it('should render via cached iframe', () => {
        return a4a.layoutCallback().then(() => {
          verifyCachedContentIframeRender(a4aElement, TEST_URL);
          // Should have reported an error.
          expect(devErrLogSpy).to.be.calledOnce;
          expect(devErrLogSpy.getCall(0).args[1]).to.have.string(
              'random illegal value');
          expect(fetchMock.called('ad')).to.be.true;
          expect(lifecycleEventStub).to.be.calledWith('renderCrossDomainStart',
              {'isAmpCreative': false, 'releaseType': 'pr'});
        });
      });
    });

    describe('#renderViaNameFrame', () => {
      beforeEach(() => {
        // If rendering type is nameframe, we SHOULD attach a NameFrame.
        adResponse.headers[RENDERING_TYPE_HEADER] = 'nameframe';
        a4a.onLayoutMeasure();
      });

      it('should attach a NameFrame when header is set', () => {
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          verifyNameFrameRender(a4aElement);
          expect(fetchMock.called('ad')).to.be.true;
        });
      });

      it('should make only one NameFrame even if onLayoutMeasure called ' +
          'multiple times', () => {
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          verifyNameFrameRender(a4aElement);
          expect(fetchMock.called('ad')).to.be.true;
        });
      });

      ['', 'client_cache', 'safeframe', 'some_random_thing'].forEach(
          headerVal => {
            it(`should not attach a NameFrame when header is ${headerVal}`,
                () => {
                  // Make sure there's no signature, so that we go down the 3p iframe path.
                  delete adResponse.headers['AMP-Fast-Fetch-Signature'];
                  delete adResponse.headers[AMP_SIGNATURE_HEADER];
                  // If rendering type is anything but nameframe, we SHOULD NOT
                  // attach a NameFrame.
                  adResponse.headers[RENDERING_TYPE_HEADER] = headerVal;
                  a4a.onLayoutMeasure();
                  return a4a.layoutCallback().then(() => {
                    // Force vsync system to run all queued tasks, so that
                    // DOM mutations are actually completed before testing.
                    a4a.vsync_.runScheduledTasks_();
                    const nameChild = a4aElement.querySelector(
                        'iframe[src^="nameframe"]');
                    expect(nameChild).to.not.be.ok;
                    if (headerVal != 'safeframe') {
                      const unsafeChild = a4aElement.querySelector('iframe');
                      expect(unsafeChild).to.be.ok;
                      expect(unsafeChild.getAttribute('src')).to.have.string(
                          TEST_URL);
                    }
                    expect(fetchMock.called('ad')).to.be.true;
                  });
                });
          });
    });

    describe('#renderViaSafeFrame', () => {
      beforeEach(() => {
        // If rendering type is safeframe, we SHOULD attach a SafeFrame.
        adResponse.headers[RENDERING_TYPE_HEADER] = 'safeframe';
        a4a.onLayoutMeasure();
      });

      it('should attach a SafeFrame when header is set', () => {
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          verifySafeFrameRender(a4aElement, DEFAULT_SAFEFRAME_VERSION);
          expect(fetchMock.called('ad')).to.be.true;
        });
      });

      it('should use safeframe version header value', () => {
        a4a.safeframeVersion_ = '1-2-3';
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          verifySafeFrameRender(a4aElement, '1-2-3');
          expect(fetchMock.called('ad')).to.be.true;
        });
      });

      it('should make only one SafeFrame even if onLayoutMeasure called ' +
          'multiple times', () => {
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          verifySafeFrameRender(a4aElement, DEFAULT_SAFEFRAME_VERSION);
          expect(fetchMock.called('ad')).to.be.true;
        });
      });

      ['', 'client_cache', 'nameframe', 'some_random_thing'].forEach(
          headerVal => {
            it(`should not attach a SafeFrame when header is ${headerVal}`,
                () => {
                  // If rendering type is anything but safeframe, we SHOULD NOT attach a
                  // SafeFrame.
                  adResponse.headers[RENDERING_TYPE_HEADER] = headerVal;
                  a4a.onLayoutMeasure();
                  return a4a.layoutCallback().then(() => {
                    // Force vsync system to run all queued tasks, so that
                    // DOM mutations are actually completed before testing.
                    a4a.vsync_.runScheduledTasks_();
                    const safeframeUrl = 'https://tpc.googlesyndication.com/safeframe/' +
                      DEFAULT_SAFEFRAME_VERSION + '/html/container.html';
                    const safeChild = a4aElement.querySelector(
                        `iframe[src^="${safeframeUrl}"]`);
                    expect(safeChild).to.not.be.ok;
                    if (headerVal != 'nameframe') {
                      const unsafeChild = a4aElement.querySelector('iframe');
                      expect(unsafeChild).to.be.ok;
                      expect(unsafeChild.getAttribute('src')).to.have.string(
                          TEST_URL);
                    }
                    expect(fetchMock.called('ad')).to.be.true;
                  });
                });
          });

      it('should reset state to null on unlayoutCallback', () => {
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          expect(a4a.experimentalNonAmpCreativeRenderMethod_)
              .to.equal('safeframe');
          a4a.unlayoutCallback();
          // QUESTION TO REVIEWERS: Do we really need the vsync.mutate in
          // AmpA4A.unlayoutCallback?  We have an open question there about
          // whether it's necessary or perhaps hazardous.  Feedback welcome.
          a4a.vsync_.runScheduledTasks_();
          expect(a4a.experimentalNonAmpCreativeRenderMethod_).to.be.null;
          expect(fetchMock.called('ad')).to.be.true;
        });
      });
    });
  });

  describe('cross-domain vs A4A', () => {
    let a4a;
    let a4aElement;
    beforeEach(() => createIframePromise().then(fixture => {
      setupForAdTesting(fixture);
      fetchMock.getOnce(
          TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
          {name: 'ad'});
      const doc = fixture.doc;
      a4aElement = createA4aElement(doc);
      a4a = new MockA4AImpl(a4aElement);
    }));
    afterEach(() => {
      expect(fetchMock.called('ad')).to.be.true;
    });

    ['nameframe', 'safeframe'].forEach(renderType => {
      it(`should not use ${renderType} if creative is A4A`, () => {
        adResponse.headers[RENDERING_TYPE_HEADER] = renderType;
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        return a4a.layoutCallback().then(() => {
          // Force vsync system to run all queued tasks, so that DOM mutations
          // are actually completed before testing.
          a4a.vsync_.runScheduledTasks_();
          verifyA4ARender(a4aElement);
        });
      });

      it(`should not use ${renderType} even if onLayoutMeasure called ` +
          'multiple times', () => {
        adResponse.headers[RENDERING_TYPE_HEADER] = renderType;
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        a4a.onLayoutMeasure();
        return a4a.layoutCallback().then(() => {
          const safeChild = a4aElement.querySelector('iframe[name]');
          expect(safeChild).to.not.be.ok;
          const crossDomainChild = a4aElement.querySelector('iframe[src]');
          expect(crossDomainChild).to.not.be.okay;
          const friendlyChild = a4aElement.querySelector('iframe[srcdoc]');
          expect(friendlyChild).to.be.ok;
          expect(friendlyChild.getAttribute('srcdoc')).to.have.string(
              '<html ⚡4ads>');
        });
      });
    });
  });

  it('should set height/width on iframe matching header value', () => {
    // Make sure there's no signature, so that we go down the 3p iframe path.
    delete adResponse.headers['AMP-Fast-Fetch-Signature'];
    delete adResponse.headers[AMP_SIGNATURE_HEADER];
    adResponse.headers['X-CreativeSize'] = '320x50';
    return createIframePromise().then(fixture => {
      setupForAdTesting(fixture);
      fetchMock.getOnce(
          TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
          {name: 'ad'});
      const doc = fixture.doc;
      const a4aElement = createA4aElement(doc);
      a4aElement.setAttribute('width', 480);
      a4aElement.setAttribute('height', 75);
      a4aElement.setAttribute('type', 'doubleclick');
      const a4a = new MockA4AImpl(a4aElement);
      doc.body.appendChild(a4aElement);
      a4a.buildCallback();
      a4a.onLayoutMeasure();
      const renderPromise = a4a.layoutCallback();
      return renderPromise.then(() => {
        // Force vsync system to run all queued tasks, so that DOM mutations
        // are actually completed before testing.
        a4a.vsync_.runScheduledTasks_();
        const child = a4aElement.querySelector('iframe[name]');
        expect(child).to.be.ok;
        expect(child.getAttribute('width')).to.equal('320');
        expect(child.getAttribute('height')).to.equal('50');
      });
    });
  });

  describe('#onLayoutMeasure', () => {
    it('resumeCallback calls onLayoutMeasure', () => {
      // Force non-FIE
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const s = doc.createElement('style');
        s.textContent = '.fixed {position:fixed;}';
        doc.head.appendChild(s);
        const a4a = new MockA4AImpl(a4aElement);
        const renderNonAmpCreativeSpy =
          sandbox.spy(a4a, 'renderNonAmpCreative_');
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.ok;
        return a4a.layoutCallback().then(() => {
          expect(renderNonAmpCreativeSpy.calledOnce,
              'renderNonAmpCreative_ called exactly once').to.be.true;
          a4a.unlayoutCallback();
          getResourceStub.returns(
            {'hasBeenMeasured': () => true, 'isMeasureRequested': () => false});
          const onLayoutMeasureSpy = sandbox.spy(a4a, 'onLayoutMeasure');
          a4a.resumeCallback();
          expect(onLayoutMeasureSpy).to.be.calledOnce;
          expect(a4a.fromResumeCallback).to.be.true;
        });
      });
    });
    it('resumeCallback does not call onLayoutMeasure for FIE', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const s = doc.createElement('style');
        s.textContent = '.fixed {position:fixed;}';
        doc.head.appendChild(s);
        const a4a = new MockA4AImpl(a4aElement);
        const renderAmpCreativeSpy = sandbox.spy(a4a, 'renderAmpCreative_');
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.ok;
        return a4a.layoutCallback().then(() => {
          expect(renderAmpCreativeSpy.calledOnce,
              'renderAmpCreative_ called exactly once').to.be.true;
          a4a.unlayoutCallback();
          const onLayoutMeasureSpy = sandbox.spy(a4a, 'onLayoutMeasure');
          a4a.resumeCallback();
          expect(onLayoutMeasureSpy).to.not.be.called;
          expect(a4a.fromResumeCallback).to.be.false;
        });
      });
    });
    it('resumeCallback w/ measure required no onLayoutMeasure', () => {
      // Force non-FIE
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const s = doc.createElement('style');
        s.textContent = '.fixed {position:fixed;}';
        doc.head.appendChild(s);
        const a4a = new MockA4AImpl(a4aElement);
        const renderNonAmpCreativeSpy =
          sandbox.spy(a4a, 'renderNonAmpCreative_');
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.ok;
        return a4a.layoutCallback().then(() => {
          expect(renderNonAmpCreativeSpy.calledOnce,
              'renderNonAmpCreative_ called exactly once').to.be.true;
          a4a.unlayoutCallback();
          const onLayoutMeasureSpy = sandbox.spy(a4a, 'onLayoutMeasure');
          getResourceStub.returns({'hasBeenMeasured': () => false});
          a4a.resumeCallback();
          expect(onLayoutMeasureSpy).to.not.be.called;
          expect(a4a.fromResumeCallback).to.be.true;
        });
      });
    });
    it('should run end-to-end and render in friendly iframe', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        const getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
        const updatePriorityStub = sandbox.stub(a4a, 'updatePriority');
        const renderAmpCreativeSpy = sandbox.spy(a4a, 'renderAmpCreative_');
        const preloadExtensionSpy =
            sandbox.spy(Extensions.prototype, 'preloadExtension');
        a4a.buildCallback();
        const lifecycleEventStub =
            sandbox.stub(a4a, 'protectedEmitLifecycleEvent_');
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.instanceof(Promise);
        return a4a.adPromise_.then(promiseResult => {
          expect(promiseResult).to.be.ok;
          expect(promiseResult.minifiedCreative).to.be.ok;
          expect(a4a.isVerifiedAmpCreative_).to.be.true;
          expect(getAdUrlSpy.calledOnce, 'getAdUrl called exactly once')
              .to.be.true;
          expect(fetchMock.called('ad')).to.be.true;
          expect(preloadExtensionSpy.withArgs('amp-font')).to.be.calledOnce;
          return a4a.layoutCallback().then(() => {
            expect(renderAmpCreativeSpy.calledOnce,
                'renderAmpCreative_ called exactly once').to.be.true;
            expect(a4aElement.getElementsByTagName('iframe').length)
                .to.equal(1);
            const friendlyIframe = a4aElement.querySelector('iframe[srcdoc]');
            expect(friendlyIframe).to.not.be.null;
            expect(friendlyIframe.getAttribute('src')).to.be.null;
            const expectedAttributes = {
              'frameborder': '0', 'allowfullscreen': '',
              'allowtransparency': '', 'scrolling': 'no'};
            Object.keys(expectedAttributes).forEach(key => {
              expect(friendlyIframe.getAttribute(key)).to.equal(
                  expectedAttributes[key]);
            });
            // Should not contain v0.js, any extensions, or amp-boilerplate.
            const iframeDoc = friendlyIframe.contentDocument;
            expect(iframeDoc.querySelector('script[src]')).to.not.be.ok;
            expect(iframeDoc.querySelector('script[custom-element]'))
                .to.not.be.ok;
            expect(iframeDoc.querySelector('style[amp-boilerplate]'))
                .to.not.be.ok;
            expect(iframeDoc.querySelector('noscript')).to.not.be.ok;
            // Should contain font link and extension in main document.
            expect(iframeDoc.querySelector(
                'link[href="https://fonts.googleapis.com/css?family=Questrial"]'))
                .to.be.ok;
            expect(doc.querySelector('script[src*="amp-font-0.1"]')).to.be.ok;
            expect(onCreativeRenderSpy).to.be.calledOnce;
            expect(updatePriorityStub).to.be.calledOnce;
            expect(updatePriorityStub.args[0][0]).to.equal(0);
            expect(lifecycleEventStub).to.be.calledWith(
                'adResponseValidateEnd', {
                  'signatureValidationResult': 0,
                  'releaseType': 'pr',
                });
          });
        });
      });
    });
    it('must not be position:fixed', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const s = doc.createElement('style');
        s.textContent = '.fixed {position:fixed;}';
        doc.head.appendChild(s);
        a4aElement.className = 'fixed';
        const a4a = new MockA4AImpl(a4aElement);
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.not.be.ok;
      });
    });
    it('does not initialize promise chain 0 height/width', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const rect = layoutRectLtwh(0, 0, 200, 0);
        const a4aElement = createA4aElement(doc, rect);
        const a4a = new MockA4AImpl(a4aElement);
        // test 0 height
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.not.be.ok;
        // test 0 width
        rect.height = 50;
        rect.width = 0;
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.not.be.ok;
        // test with non-zero height/width
        rect.width = 200;
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.ok;
      });
    });
    function executeLayoutCallbackTest(isValidCreative, opt_failAmpRender) {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        const getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
        const updatePriorityStub = sandbox.stub(a4a, 'updatePriority');
        if (!isValidCreative) {
          delete adResponse.headers['AMP-Fast-Fetch-Signature'];
          delete adResponse.headers[AMP_SIGNATURE_HEADER];
        }
        if (opt_failAmpRender) {
          sandbox.stub(a4a, 'renderAmpCreative_').returns(
              Promise.reject('amp render failure'));
        }
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.instanceof(Promise);
        return a4a.adPromise_.then(promiseResult => {
          expect(getAdUrlSpy.calledOnce, 'getAdUrl called exactly once')
              .to.be.true;
          expect(fetchMock.called('ad')).to.be.true;
          expect(a4a.isVerifiedAmpCreative_).to.equal(isValidCreative);
          if (isValidCreative) {
            expect(promiseResult).to.be.ok;
            expect(promiseResult.minifiedCreative).to.be.ok;
          } else {
            expect(promiseResult).to.not.be.ok;
          }
          return a4a.layoutCallback().then(() => {
            expect(a4aElement.getElementsByTagName('iframe').length)
                .to.not.equal(0);
            const iframe = a4aElement.getElementsByTagName('iframe')[0];
            if (isValidCreative && !opt_failAmpRender) {
              expect(iframe.getAttribute('src')).to.be.null;
              expect(onCreativeRenderSpy.withArgs(true)).to.be.calledOnce;
              expect(updatePriorityStub).to.be.calledOnce;
              expect(updatePriorityStub.args[0][0]).to.equal(0);
            } else {
              expect(iframe.getAttribute('srcdoc')).to.be.null;
              expect(iframe.src, 'verify iframe src w/ origin').to
                  .equal(TEST_URL +
                         '&__amp_source_origin=about%3Asrcdoc');
              expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
              if (!opt_failAmpRender) {
                expect(updatePriorityStub).to.not.be.called;
              }
            }
          });
        });
      });
    }
    it('#layoutCallback valid AMP', () => {
      return executeLayoutCallbackTest(true);
    });
    it('#layoutCallback not valid AMP', () => {
      return executeLayoutCallbackTest(false);
    });
    it('#layoutCallback AMP render fail, recover non-AMP', () => {
      return executeLayoutCallbackTest(true, true);
    });
    it('should run end-to-end in the presence of an XHR error', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
            Promise.reject(networkFailure()), {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        const getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
        const onNetworkFailureSpy = sandbox.spy(a4a, 'onNetworkFailure');
        a4a.buildCallback();
        const lifecycleEventStub = sandbox.stub(
            a4a, 'protectedEmitLifecycleEvent_');
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.instanceof(Promise);
        return a4a.layoutCallback().then(() => {
          expect(getAdUrlSpy, 'getAdUrl called exactly once').to.be.calledOnce;
          expect(onNetworkFailureSpy,
              'onNetworkFailureSpy called exactly once').to.be.calledOnce;
          // Verify iframe presence and lack of visibility hidden
          const iframe = a4aElement.querySelector('iframe[src]');
          expect(iframe).to.be.ok;
          expect(iframe.src.indexOf(TEST_URL)).to.equal(0);
          expect(iframe).to.be.visible;
          expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
          expect(lifecycleEventStub).to.be.calledWith('networkError');
        });
      });
    });
    it('should use adUrl from onNetworkFailure', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
            Promise.reject(networkFailure()), {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        const getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
        sandbox.stub(a4a, 'onNetworkFailure')
            .withArgs(sinon.match(val =>
              val.message && val.message.indexOf('XHR Failed fetching') == 0),
            TEST_URL)
            .returns({adUrl: TEST_URL + '&err=true'});
        a4a.buildCallback();
        const lifecycleEventStub = sandbox.stub(
            a4a, 'protectedEmitLifecycleEvent_');
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.instanceof(Promise);
        return a4a.layoutCallback().then(() => {
          expect(getAdUrlSpy, 'getAdUrl called exactly once').to.be.calledOnce;
          // Verify iframe presence and lack of visibility hidden
          const iframe = a4aElement.querySelector('iframe[src]');
          expect(iframe).to.be.ok;
          expect(iframe.src.indexOf(TEST_URL)).to.equal(0);
          expect(/&err=true/.test(iframe.src), iframe.src).to.be.true;
          expect(iframe).to.be.visible;
          expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
          expect(lifecycleEventStub).to.be.calledWith('networkError');
        });
      });
    });
    it('should not execute frame GET if disabled via onNetworkFailure', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
            Promise.reject(networkFailure()), {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        const getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
        sandbox.stub(a4a, 'onNetworkFailure')
            .withArgs(sinon.match(val =>
              val.message && val.message.indexOf('XHR Failed fetching') == 0),
            TEST_URL)
            .returns({frameGetDisabled: true});
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        return a4a.layoutCallback().then(() => {
          expect(getAdUrlSpy, 'getAdUrl called exactly once').to.be.calledOnce;
          const iframe = a4aElement.querySelector('iframe');
          expect(iframe).to.not.be.ok;
        });
      });
    });
    it('should handle XHR error when resolves before layoutCallback', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
            Promise.reject(networkFailure()), {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        return a4a.adPromise_.then(() => a4a.layoutCallback().then(() => {
          // Verify iframe presence and lack of visibility hidden
          expect(a4aElement.querySelectorAll('iframe').length).to.equal(1);
          const iframe = a4aElement.querySelectorAll('iframe')[0];
          expect(iframe.src.indexOf(TEST_URL)).to.equal(0);
          expect(iframe).to.be.visible;
          expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
        }));
      });
    });
    it('should handle XHR error when resolves after layoutCallback', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        let rejectXhr;
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
            new Promise((unusedResolve, reject) => {
              rejectXhr = reject;
            }),
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        const layoutCallbackPromise = a4a.layoutCallback();
        rejectXhr(networkFailure());
        return layoutCallbackPromise.then(() => {
          // Verify iframe presence and lack of visibility hidden
          expect(a4aElement.querySelectorAll('iframe').length).to.equal(1);
          const iframe = a4aElement.querySelectorAll('iframe')[0];
          expect(iframe.src.indexOf(TEST_URL)).to.equal(0);
          expect(iframe).to.be.visible;
          expect(onCreativeRenderSpy.withArgs(false)).to.be.called;
        });
      });
    });
    it('should collapse for 204 response code', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        adResponse.status = 204;
        adResponse.body = null;
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        const forceCollapseSpy = sandbox.spy(a4a, 'forceCollapse');
        const noContentUISpy = sandbox.spy();
        const unlayoutUISpy = sandbox.spy();
        a4a.uiHandler = {
          applyNoContentUI: () => {noContentUISpy();},
          applyUnlayoutUI: () => {unlayoutUISpy();},
        };
        sandbox.stub(a4a, 'getLayoutBox').returns({width: 123, height: 456});
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.ok;
        return a4a.adPromise_.then(() => {
          expect(forceCollapseSpy).to.be.calledOnce;
          expect(noContentUISpy).to.be.calledOnce;
          return a4a.layoutCallback().then(() => {
            // should have no iframe.
            expect(a4aElement.querySelector('iframe')).to.not.be.ok;
            expect(onCreativeRenderSpy).to.not.be.called;
            // call unlayout callback and verify it attempts to revert the size
            expect(a4a.originalSlotSize_).to.deep
                .equal({width: 123, height: 456});
            let attemptChangeSizeResolver;
            const attemptChangeSizePromise = new Promise(resolve => {
              attemptChangeSizeResolver = resolve;
            });
            sandbox.stub(AMP.BaseElement.prototype, 'attemptChangeSize')
                .returns(attemptChangeSizePromise);
            a4a.unlayoutCallback();
            expect(unlayoutUISpy).to.be.calledOnce;
            expect(a4a.originalSlotSize_).to.be.ok;
            attemptChangeSizeResolver();
            return Services.timerFor(a4a.win).promise(1).then(() => {
              expect(a4a.originalSlotSize_).to.not.be.ok;
            });
          });
        });
      });
    });
    it('should collapse for empty array buffer', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        adResponse.body = '';
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        const forceCollapseSpy = sandbox.spy(a4a, 'forceCollapse');
        const noContentUISpy = sandbox.spy();
        a4a.uiHandler = {
          applyNoContentUI: () => {noContentUISpy();},
          applyUnlayoutUI: () => {},
        };
        sandbox.stub(a4a, 'getLayoutBox').returns({width: 123, height: 456});
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_).to.be.ok;
        return a4a.adPromise_.then(() => {
          expect(forceCollapseSpy).to.be.calledOnce;
          expect(noContentUISpy).to.be.calledOnce;
          return a4a.layoutCallback().then(() => {
            // should have no iframe.
            expect(a4aElement.querySelector('iframe')).to.not.be.ok;
            expect(onCreativeRenderSpy).to.not.be.called;
            // call unlayout callback and verify it attempts to revert the size
            expect(a4a.originalSlotSize_).to.deep
                .equal({width: 123, height: 456});
            let attemptChangeSizeResolver;
            const attemptChangeSizePromise = new Promise(resolve => {
              attemptChangeSizeResolver = resolve;
            });
            sandbox.stub(AMP.BaseElement.prototype, 'attemptChangeSize')
                .returns(attemptChangeSizePromise);
            a4a.unlayoutCallback();
            expect(a4a.originalSlotSize_).to.be.ok;
            attemptChangeSizeResolver();
            return Services.timerFor(a4a.win).promise(1).then(() => {
              expect(a4a.originalSlotSize_).to.not.be.ok;
            });
          });
        });
      });

      it('should process safeframe version header properly', () => {
        adResponse.headers[SAFEFRAME_VERSION_HEADER] = '1-2-3';
        adResponse.headers[RENDERING_TYPE_HEADER] = 'safeframe';
        delete adResponse.headers['AMP-Fast-Fetch-Signature'];
        delete adResponse.headers[AMP_SIGNATURE_HEADER];
        return createIframePromise().then(fixture => {
          setupForAdTesting(fixture);
          fetchMock.getOnce(
              TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
              () => adResponse, {name: 'ad'});
          const doc = fixture.doc;
          const a4aElement = createA4aElement(doc);
          const a4a = new MockA4AImpl(a4aElement);
          a4a.buildCallback();
          a4a.onLayoutMeasure();
          return a4a.adPromise_.then(() => {
            expect(fetchMock.called('ad')).to.be.true;
            return a4a.layoutCallback().then(() => {
              verifySafeFrameRender(a4aElement, '1-2-3');
              // Verify preload to safeframe with header version.
              expect(doc.querySelector('link[rel=preload]' +
                '[href="https://tpc.googlesyndication.com/safeframe/' +
                '1-2-3/html/container.html"]')).to.be.ok;
            });
          });
        });
      });
    });

    describe('delay request experiment', () => {
      let getAdUrlSpy;
      let a4a;
      beforeEach(() => {
        return createIframePromise().then(fixture => {
          setupForAdTesting(fixture);
          fetchMock.getOnce(
              TEST_URL + '&__amp_source_origin=about%3Asrcdoc',
              () => adResponse, {name: 'ad'});
          const doc = fixture.doc;
          const a4aElement = createA4aElement(doc);
          a4a = new MockA4AImpl(a4aElement);
          getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
          sandbox.stub(a4a, 'delayAdRequestEnabled').returns(true);
        });
      });
      it('should not delay request when in viewport', () => {
        getResourceStub.returns(
            {
              getUpgradeDelayMs: () => 1,
              renderOutsideViewport: () => true,
              whenWithinRenderOutsideViewport: () => {
                throw new Error('failure!');
              },
            });
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_);
        return a4a.adPromise_.then(() => {
          expect(getAdUrlSpy).to.be.calledOnce;
        });
      });
      it('should delay request until within renderOutsideViewport',() => {
        let whenWithinRenderOutsideViewportResolve;
        getResourceStub.returns(
            {
              getUpgradeDelayMs: () => 1,
              renderOutsideViewport: () => false,
              whenWithinRenderOutsideViewport: () => new Promise(resolve => {
                whenWithinRenderOutsideViewportResolve = resolve;
              }),
            });
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        expect(a4a.adPromise_);
        // Delay to all getAdUrl to potentially execute.
        return Services.timerFor(a4a.win).promise(1).then(() => {
          expect(getAdUrlSpy).to.not.be.called;
          whenWithinRenderOutsideViewportResolve();
          return a4a.adPromise_.then(() => {
            expect(getAdUrlSpy).to.be.calledOnce;
          });
        });
      });
    });
    it('should ignore invalid safeframe version header', () => {
      adResponse.headers[SAFEFRAME_VERSION_HEADER] = 'some-bad-item';
      adResponse.headers[RENDERING_TYPE_HEADER] = 'safeframe';
      delete adResponse.headers['AMP-Fast-Fetch-Signature'];
      delete adResponse.headers[AMP_SIGNATURE_HEADER];
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        return a4a.adPromise_.then(() => {
          expect(fetchMock.called('ad')).to.be.true;
          return a4a.layoutCallback().then(() => {
            verifySafeFrameRender(a4aElement, DEFAULT_SAFEFRAME_VERSION);
          });
        });
      });
    });
    // TODO(tdrl): Go through case analysis in amp-a4a.js#onLayoutMeasure and
    // add one test for each case / ensure that all cases are covered.
  });

  describe('#preconnectCallback', () => {
    it('validate adsense', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        //a4a.config = {};
        a4a.buildCallback();
        a4a.preconnectCallback(false);
        const preconnects = doc.querySelectorAll('link[rel=preconnect]');
        expect(preconnects).to.have.lengthOf(3);
        // SafeFrame origin.
        expect(preconnects[0]).to.have.property(
            'href', 'https://tpc.googlesyndication.com/');
        // NameFrame origin (in testing mode).  Use a substring match here to
        // be agnostic about localhost server port.
        expect(preconnects[1]).to.have.property('href')
            .that.has.string('http://ads.localhost');
        // AdSense origin.
        expect(preconnects[2]).to.have.property(
            'href', 'https://googleads.g.doubleclick.net/');
      });
    });
  });

  describe('#getAmpAdMetadata_', () => {
    let a4a;
    beforeEach(() => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        a4a = new MockA4AImpl(createA4aElement(fixture.doc));
        return fixture;
      });
    });
    it('should parse metadata', () => {
      const actual = a4a.getAmpAdMetadata_(buildCreativeString({
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {href: 'https://fonts.com/css?helloworld'},
        ],
      }));
      const expected = {
        minifiedCreative: testFragments.minimalDocOneStyleSrcDoc,
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {href: 'https://fonts.com/css?helloworld'},
        ],
      };
      expect(actual).to.deep.equal(expected);
    });
    // TODO(levitzky) remove the following two tests after metadata bug is
    // fixed.
    it('should parse metadata with wrong opening tag', () => {
      const creative = buildCreativeString({
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {href: 'https://fonts.com/css?helloworld'},
        ],
      }).replace('<script type="application/json" amp-ad-metadata>',
          '<script type=application/json amp-ad-metadata>');
      const actual = a4a.getAmpAdMetadata_(creative);
      const expected = {
        minifiedCreative: testFragments.minimalDocOneStyleSrcDoc,
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {href: 'https://fonts.com/css?helloworld'},
        ],
      };
      expect(actual).to.deep.equal(expected);
    });
    it('should return null if metadata opening tag is (truly) wrong', () => {
      const creative = buildCreativeString({
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {href: 'https://fonts.com/css?helloworld'},
        ],
      }).replace('<script type="application/json" amp-ad-metadata>',
          '<script type=application/json" amp-ad-metadata>');
      expect(a4a.getAmpAdMetadata_(creative)).to.be.null;
    });

    it('should return null if missing ampRuntimeUtf16CharOffsets', () => {
      const baseTestDoc = testFragments.minimalDocOneStyle;
      const splicePoint = baseTestDoc.indexOf('</body>');
      expect(a4a.getAmpAdMetadata_(
          baseTestDoc.slice(0, splicePoint) +
        '<script type="application/json" amp-ad-metadata></script>' +
        baseTestDoc.slice(splicePoint))).to.be.null;
    });
    it('should return null if invalid extensions', () => {
      expect(a4a.getAmpAdMetadata_(buildCreativeString({
        customElementExtensions: 'amp-vine',
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {href: 'https://fonts.com/css?helloworld'},
        ],
      }))).to.be.null;
    });
    it('should return null if non-array stylesheets', () => {
      expect(a4a.getAmpAdMetadata_(buildCreativeString({
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: 'https://fonts.googleapis.com/css?foobar',
      }))).to.be.null;
    });
    it('should return null if invalid stylesheet object', () => {
      expect(a4a.getAmpAdMetadata_(buildCreativeString({
        customElementExtensions: ['amp-vine', 'amp-vine', 'amp-vine'],
        customStylesheets: [
          {href: 'https://fonts.googleapis.com/css?foobar'},
          {foo: 'https://fonts.com/css?helloworld'},
        ],
      }))).to.be.null;
    });
    // FAILURE cases here
  });

  describe('#renderOutsideViewport', () => {
    let a4aElement;
    let a4a;
    let fixture;
    beforeEach(() => {
      return createIframePromise().then(f => {
        setupForAdTesting(f);
        fixture = f;
        a4aElement = createA4aElement(fixture.doc);
        a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        return fixture;
      });
    });
    it('should return false if throttled', () => {
      incrementLoadingAds(fixture.win);
      expect(a4a.renderOutsideViewport()).to.be.false;
    });
    it('should return true if throttled, but AMP creative', () => {
      incrementLoadingAds(fixture.win);
      a4a.isVerifiedAmpCreative_ = true;
      expect(a4a.renderOutsideViewport()).to.equal(3);
    });
    it('should return 1.25 if prefer-viewability-over-views', () => {
      a4aElement.setAttribute(
          'data-loading-strategy', 'prefer-viewability-over-views');
      expect(a4a.renderOutsideViewport()).to.equal(1.25);
      a4a.isVerifiedAmpCreative_ = true;
      expect(a4a.renderOutsideViewport()).to.equal(1.25);
    });
  });

  describe('#renderAmpCreative_', () => {
    const metaData = AmpA4A.prototype.getAmpAdMetadata_(buildCreativeString());
    let a4aElement;
    let a4a;
    beforeEach(() => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        const doc = fixture.doc;
        a4aElement = createA4aElement(doc);
        a4a = new AmpA4A(a4aElement);
        sandbox.stub(a4a, 'getFallback', () => {return true;});
        a4a.buildCallback();
        a4a.adUrl_ = 'https://nowhere.org';
      });
    });
    it('should render correctly', () => {
      return a4a.renderAmpCreative_(metaData).then(() => {
        // Verify iframe presence.
        expect(a4aElement.children.length).to.equal(1);
        const friendlyIframe = a4aElement.children[0];
        expect(friendlyIframe.tagName).to.equal('IFRAME');
        expect(friendlyIframe.src).to.not.be.ok;
        expect(friendlyIframe.srcdoc).to.be.ok;
        const frameDoc = friendlyIframe.contentDocument;
        const styles = frameDoc.querySelectorAll('style[amp-custom]');
        expect(Array.prototype.some.call(styles,
            s => {
              return s.innerHTML == 'p { background: green }';
            }),
            'Some style is "background: green"').to.be.true;
        expect(frameDoc.body.innerHTML.trim()).to.equal('<p>some text</p>');
        expect(Services.urlReplacementsForDoc(frameDoc))
            .to.not.equal(Services.urlReplacementsForDoc(a4aElement));
      });
    });

    it('should handle click expansion correctly', () => {
      return a4a.renderAmpCreative_(metaData).then(() => {
        const adBody = a4aElement.querySelector('iframe')
            .contentDocument.querySelector('body');
        let clickHandlerCalled = 0;

        adBody.onclick = function(e) {
          expect(e.defaultPrevented).to.be.false;
          e.preventDefault();  // Make the test not actually navigate.
          clickHandlerCalled++;
        };
        adBody.innerHTML = '<a ' +
            'href="https://f.co?CLICK_X,CLICK_Y,RANDOM">' +
            '<button id="target"><button></div>';
        const button = adBody.querySelector('#target');
        const a = adBody.querySelector('a');
        const ev1 = new Event('click', {bubbles: true});
        ev1.pageX = 10;
        ev1.pageY = 20;
        button.dispatchEvent(ev1);
        expect(a.href).to.equal('https://f.co/?10,20,RANDOM');
        expect(clickHandlerCalled).to.equal(1);

        const ev2 = new Event('click', {bubbles: true});
        ev2.pageX = 111;
        ev2.pageY = 222;
        a.dispatchEvent(ev2);
        expect(a.href).to.equal('https://f.co/?111,222,RANDOM');
        expect(clickHandlerCalled).to.equal(2);

        const ev3 = new Event('click', {bubbles: true});
        ev3.pageX = 666;
        ev3.pageY = 666;
        // Click parent of a tag.
        a.parentElement.dispatchEvent(ev3);
        // Had no effect, because actual link wasn't clicked.
        expect(a.href).to.equal('https://f.co/?111,222,RANDOM');
        expect(clickHandlerCalled).to.equal(3);
      });
    });
  });

  describe('#getPriority', () => {
    it('validate priority', () => {
      expect(AmpA4A.prototype.getPriority()).to.equal(2);
    });
  });

  describe('#unlayoutCallback', () => {
    it('verify state reset', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        return a4a.onLayoutMeasure(() => {
          expect(a4a.adPromise_).to.not.be.null;
          expect(a4a.element.children).to.have.lengthOf(1);
        });
      });
    });

    it('attemptChangeSize reverts', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        fetchMock.getOnce(
            TEST_URL + '&__amp_source_origin=about%3Asrcdoc', () => adResponse,
            {name: 'ad'});
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        const attemptChangeSizeStub =
          sandbox.stub(AMP.BaseElement.prototype, 'attemptChangeSize');
        // Expect called twice: one for resize and second for reverting.
        attemptChangeSizeStub.withArgs(123, 456).returns(Promise.resolve());
        attemptChangeSizeStub.withArgs(200, 50).returns(Promise.resolve());
        a4a.attemptChangeSize(123, 456);
        a4a.layoutCallback(() => {
          expect(a4aElement.querySelector('iframe')).to.be.ok;
          a4a.unlayoutCallback();
        });
      });
    });

    it('verify cancelled promise', () => {
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        let whenFirstVisibleResolve = null;
        viewerWhenVisibleMock.returns(new Promise(resolve => {
          whenFirstVisibleResolve = resolve;
        }));
        const doc = fixture.doc;
        const a4aElement = createA4aElement(doc);
        const a4a = new MockA4AImpl(a4aElement);
        const getAdUrlSpy = sandbox.spy(a4a, 'getAdUrl');
        const errorHandlerSpy = sandbox.spy(a4a, 'promiseErrorHandler_');
        a4a.buildCallback();
        a4a.onLayoutMeasure();
        const adPromise = a4a.adPromise_;
        // This is to prevent `applyUnlayoutUI` to be called;
        a4a.uiHandler.state = 0;
        a4a.unlayoutCallback();
        // Force vsync system to run all queued tasks, so that DOM mutations
        // are actually completed before testing.
        a4a.vsync_.runScheduledTasks_();
        whenFirstVisibleResolve();
        return adPromise.then(unusedError => {
          assert.fail('cancelled ad promise should not succeed');
        }).catch(reason => {
          expect(getAdUrlSpy.called, 'getAdUrl never called')
              .to.be.false;
          expect(reason).to.deep.equal(cancellation());
          expect(errorHandlerSpy).to.be.calledOnce;
        });
      });
    });

    describe('protectFunctionWrapper', () => {
      it('works properly with no error', () => {
        let errorCalls = 0;
        expect(protectFunctionWrapper(name => {
          return `hello ${name}`;
        }, null, () => {errorCalls++;})('world')).to.equal('hello world');
        expect(errorCalls).to.equal(0);
      });

      it('handles error properly', () => {
        const err = new Error('test fail');
        expect(protectFunctionWrapper((name, suffix) => {
          expect(name).to.equal('world');
          expect(suffix).to.equal('!');
          throw err;
        }, null, (currErr, name, suffix) => {
          expect(currErr).to.equal(err);
          expect(name).to.equal('world');
          expect(suffix).to.equal('!');
          return 'pass';
        })('world', '!')).to.equal('pass');
      });

      it('returns undefined if error thrown in error handler', () => {
        const err = new Error('test fail within fn');
        expect(protectFunctionWrapper((name, suffix) => {
          expect(name).to.equal('world');
          expect(suffix).to.be.undefined;
          throw err;
        }, null, (currErr, name, suffix) => {
          expect(currErr).to.equal(err);
          expect(name).to.equal('world');
          expect(suffix).to.be.undefined;
          throw new Error('test fail within error fn');
        })('world')).to.be.undefined;
      });
    });

    describe('verifySignature_', () => {
      let stubVerifySignature;
      let a4a;
      beforeEach(() => {
        return createIframePromise().then(fixture => {
          forceExperimentBranch(
              fixture.win, VERIFIER_EXP_NAME, LEGACY_VERIFIER_EID);
          setupForAdTesting(fixture);
          const a4aElement = createA4aElement(fixture.doc);
          a4a = new MockA4AImpl(a4aElement);
          a4a.buildCallback();
          stubVerifySignature =
              sandbox.stub(signatureVerifierFor(a4a.win), 'verifySignature_');
        });
      });

      it('properly handles all failures', () => {
        // Multiple providers with multiple keys each that all fail validation
        signatureVerifierFor(a4a.win).keys_ = (() => {
          const providers = [];
          for (let i = 0; i < 10; i++) {
            const signingServiceName = `test-service${i}`;
            providers[i] = Promise.resolve({signingServiceName, keys: [
              Promise.resolve({signingServiceName}),
              Promise.resolve({signingServiceName}),
            ]});
          }
          return providers;
        })();
        stubVerifySignature.returns(Promise.resolve(false));
        const headers = new Headers();
        headers.set(AMP_SIGNATURE_HEADER, 'some_sig');
        return signatureVerifierFor(a4a.win).verify(
            utf8EncodeSync('some_creative'), headers, () => {})
            .then(status => {
              expect(status).to.equal(
                  VerificationStatus.ERROR_SIGNATURE_MISMATCH);
              expect(stubVerifySignature).to.be.callCount(20);
            });
      });

      it('properly handles multiple keys for one provider', () => {
        // Single provider with first key fails but second key passes validation
        const signingServiceName = 'test-service';
        signatureVerifierFor(a4a.win).keys_ = [
          Promise.resolve({signingServiceName, keys: [
            Promise.resolve({signingServiceName: '1'}),
            Promise.resolve({signingServiceName: '2'}),
          ]}),
        ];
        const creative = 'some_creative';
        const headers = new Headers();
        headers.set(AMP_SIGNATURE_HEADER, 'some_sig');
        stubVerifySignature.onCall(0).returns(Promise.resolve(false));
        stubVerifySignature.onCall(1).returns(Promise.resolve(true));
        return signatureVerifierFor(a4a.win).verify(
            utf8EncodeSync(creative), headers, () => {})
            .then(status => {
              expect(stubVerifySignature).to.be.calledTwice;
              expect(status).to.equal(VerificationStatus.OK);
            });
      });

      it('properly stops verification at first valid key', () => {
        // Single provider where first key fails, second passes, and third
        // never calls verifySignature.
        const signingServiceName = 'test-service';
        let keyInfoResolver;
        signatureVerifierFor(a4a.win).keys_ = [
          Promise.resolve({signingServiceName, keys: [
            Promise.resolve({}),
            Promise.resolve({}),
            new Promise(resolver => {
              keyInfoResolver = resolver;
            }),
          ]}),
        ];
        const creative = 'some_creative';
        const headers = new Headers();
        headers.set(AMP_SIGNATURE_HEADER, 'some_signature');
        stubVerifySignature.onCall(0).returns(Promise.resolve(false));
        stubVerifySignature.onCall(1).returns(Promise.resolve(true));

        // From testing have found that need to yield prior to calling last
        // key info resolver to ensure previous keys have had a chance to
        // execute.
        setTimeout(() => {keyInfoResolver({}); }, 0);

        return signatureVerifierFor(a4a.win).verify(
            utf8EncodeSync(creative), headers, () => {})
            .then(status => {
              expect(stubVerifySignature).to.be.calledTwice;
              expect(status).to.equal(VerificationStatus.OK);
            });
      });
    });
  });

  describe('error handler', () => {
    let a4aElement;
    let a4a;
    let userErrorStub;
    let userWarnStub;
    let devExpectedErrorStub;

    beforeEach(() => {
      userErrorStub = sandbox.stub(user(), 'error');
      userWarnStub = sandbox.stub(user(), 'warn');
      devExpectedErrorStub = sandbox.stub(dev(), 'expectedError');
      return createIframePromise().then(fixture => {
        setupForAdTesting(fixture);
        const doc = fixture.doc;
        a4aElement = createA4aElement(doc);
        a4a = new MockA4AImpl(a4aElement);
        a4a.adUrl_ = 'https://acme.org?query';
      });
    });

    it('should rethrow cancellation', () => {
      expect(() => {
        a4a.promiseErrorHandler_(cancellation());
      }).to.throw(/CANCELLED/);
    });

    it('should create an error if needed', () => {
      window.AMP_MODE = {development: true};
      a4a.promiseErrorHandler_('intentional');
      expect(userErrorStub).to.be.calledOnce;
      expect(userErrorStub.args[0][1]).to.be.instanceOf(Error);
      expect(userErrorStub.args[0][1].message).to.be.match(/intentional/);
      expect(userErrorStub.args[0][1].ignoreStack).to.be.undefined;
    });

    it('should configure ignoreStack when specified', () => {
      window.AMP_MODE = {development: true};
      a4a.promiseErrorHandler_('intentional', /* ignoreStack */ true);
      expect(userErrorStub).to.be.calledOnce;
      expect(userErrorStub.args[0][1]).to.be.instanceOf(Error);
      expect(userErrorStub.args[0][1].message).to.be.match(/intentional/);
      expect(userErrorStub.args[0][1].ignoreStack).to.equal(true);
    });

    it('should route error to user.error in dev mode', () => {
      const error = new Error('intentional');
      window.AMP_MODE = {development: true};
      a4a.promiseErrorHandler_(error);
      expect(userErrorStub).to.be.calledOnce;
      expect(userErrorStub.args[0][1]).to.be.equal(error);
      expect(error.message).to.equal('amp-a4a: adsense: intentional');
      expect(error.args).to.deep.equal({au: 'query'});
      expect(devExpectedErrorStub).to.not.be.called;
    });

    it('should route error to user.warn in prod mode', () => {
      const error = new Error('intentional');
      window.AMP_MODE = {development: false};
      a4a.promiseErrorHandler_(error);
      expect(userWarnStub).to.be.calledOnce;
      expect(userWarnStub.args[0][1]).to.be.equal(error);
      expect(error.message).to.equal('amp-a4a: adsense: intentional');
      expect(error.args).to.deep.equal({au: 'query'});
    });

    it('should send an expected error in prod mode with sampling', () => {
      const error = new Error('intentional');
      sandbox.stub(Math, 'random', () => 0.005);
      window.AMP_MODE = {development: false};
      a4a.promiseErrorHandler_(error);
      expect(devExpectedErrorStub).to.be.calledOnce;
      expect(devExpectedErrorStub.args[0][1]).to.be.equal(error);
      expect(error.message).to.equal('amp-a4a: adsense: intentional');
      expect(error.args).to.deep.equal({au: 'query'});
    });

    it('should NOT send an expected error in prod mode with sampling', () => {
      const error = new Error('intentional');
      sandbox.stub(Math, 'random', () => 0.011);
      window.AMP_MODE = {development: false};
      a4a.promiseErrorHandler_(error);
      expect(devExpectedErrorStub).to.not.be.called;
    });
  });

  describe('#assignAdUrlToError', () => {

    it('should attach info to error correctly', () => {
      const error = new Error('foo');
      let queryString = '';
      while (queryString.length < 300) {
        queryString += 'def=abcdefg&';
      }
      const url = 'https://foo.com?' + queryString;
      assignAdUrlToError(error, url);
      expect(error.args).to.jsonEqual({au: queryString.substring(0, 250)});
      // Calling again with different url has no effect.
      assignAdUrlToError(error, 'https://someothersite.com?bad=true');
      expect(error.args).to.jsonEqual({au: queryString.substring(0, 250)});
    });

    it('should not modify if no query string', () => {
      const error = new Error('foo');
      assignAdUrlToError(error, 'https://foo.com');
      expect(error.args).to.not.be.ok;
    });
  });

  describe('#extractSize', () => {

    it('should return a size', () => {
      expect(AmpA4A.prototype.extractSize(new Headers({
        'X-CreativeSize': '320x50',
      }))).to.deep.equal({width: 320, height: 50});
    });

    it('should return no size', () => {
      expect(AmpA4A.prototype.extractSize(new Headers())).to.be.null;
    });
  });

  describe('refresh', () => {
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.sandbox.create();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should effectively reset the slot and invoke given callback', () => {
      return createIframePromise().then(f => {
        const fixture = f;
        setupForAdTesting(fixture);
        const a4aElement = createA4aElement(fixture.doc);
        const a4a = new MockA4AImpl(a4aElement);
        a4a.adPromise_ = Promise.resolve();
        a4a.getAmpDoc = () => a4a.win.document;
        a4a.getResource = () => {
          return {
            layoutCanceled: () => {},
          };
        };
        a4a.mutateElement = func => func();
        a4a.togglePlaceholder = sandbox.spy();

        // We don't really care about the behavior of the following methods, so
        // long as they're called the appropriate number of times. We stub them
        // out here because they would otherwise throw errors unrelated to the
        // behavior actually being tested.
        const initiateAdRequestMock =
            sandbox.stub(AmpA4A.prototype, 'initiateAdRequest');
        initiateAdRequestMock.returns(undefined);
        const tearDownSlotMock = sandbox.stub(AmpA4A.prototype, 'tearDownSlot');
        tearDownSlotMock.returns(undefined);
        const destroyFrameMock = sandbox.stub(AmpA4A.prototype, 'destroyFrame');
        destroyFrameMock.returns(undefined);

        expect(a4a.isRefreshing).to.be.false;
        return a4a.refresh(() => {}).then(() => {
          expect(initiateAdRequestMock).to.be.calledOnce;
          expect(tearDownSlotMock).to.be.calledOnce;
          expect(a4a.togglePlaceholder).to.be.calledOnce;
          expect(a4a.isRefreshing).to.be.true;
          expect(a4a.isRelayoutNeededFlag).to.be.true;
        });
      });
    });
  });

  describe('buildCallback', () => {
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.sandbox.create();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should emit upgradeDelay lifecycle ping', () => {
      return createIframePromise().then(fixture => {
        const a4a = new MockA4AImpl(createA4aElement(fixture.doc));
        const emitLifecycleEventSpy = sandbox.spy(a4a, 'emitLifecycleEvent');
        a4a.buildCallback();
        expect(emitLifecycleEventSpy.withArgs('upgradeDelay', {
          'forced_delta': 12345,
        })).to.be.calledOnce;
      });
    });
  });

  // TODO(tdrl): Other cases to handle for parsing JSON metadata:
  //   - Metadata tag(s) missing
  //   - JSON parse failure
  //   - Tags present, but JSON empty
  // Other cases to handle for CSS reformatting:
  //   - CSS embedded in larger doc
  //   - Multiple replacement offsets
  //   - Erroneous replacement offsets
  // Other cases to handle for body reformatting:
  //   - All
});
