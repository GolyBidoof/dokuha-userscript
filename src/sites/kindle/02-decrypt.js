    // A page image arrives one of two ways, chosen by the render manifest's
    // cdn.isEncrypted flag rather than by the reader's wishes:
    //
    //   isEncrypted: false   application/octet-stream, the finished JPEG bytes
    //   isEncrypted: true    text/plain, an ASCII base64 body in three
    //                        fixed-width pieces:
    //
    //                          chars  0..23   base64( salt )       16 bytes
    //                          chars 24..47   base64( iv )         16 bytes
    //                          chars 48..     base64( ciphertext ) AES-GCM
    //
    // The two fixed-width chunks therefore always end in "==" at offsets 22 and
    // 46 — that padding inside the body is the tell, and the reason this cannot
    // be treated as one base64 stream (a standard decoder stops at the first
    // "=" and would silently truncate the key material to 16 bytes).
    //
    // The key is not a secret the viewer fetches: it is 40 characters cut out
    // of the karamel token it already holds, at an offset derived from that
    // token's own expiry:
    //
    //     key = token.substring(expiresAt % 60, expiresAt % 60 + 40)
    //
    // and the first 9 characters of that key are also the AES-GCM additional
    // data. Recovered from the deobfuscated viewer bundle and confirmed against
    // the GCM tag: of the 60 possible offsets exactly one authenticates the
    // payload, and it is expiresAt % 60 (see verify_kindle_protocol.mjs in
    // kindle-free-manga/).
    const KINDLE_KEY_LENGTH = 40;
    const KINDLE_KEY_AAD_LENGTH = 9;
    const KINDLE_SALT_CHARS = 24;                       // base64 of 16 bytes
    const KINDLE_IV_CHARS = KINDLE_SALT_CHARS;
    const KINDLE_FRAME_CHARS = KINDLE_SALT_CHARS + KINDLE_IV_CHARS;

    function kindleBase64ToBytes(text) {
        const s = String(text || '');
        let binary = null;
        try { binary = atob(s); } catch (e) { binary = null; }
        if (binary == null) {
            // Tolerate a manager that has replaced atob, and the whitespace a
            // wrapped body would carry.
            const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
            try { binary = atob(clean); } catch (e) { binary = null; }
        }
        if (binary == null) throw new Error('the page payload is not valid base64');
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    }

    function kindleBytesToText(bytes) {
        try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {}
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    function kindleLooksLikeJpeg(bytes) {
        return !!bytes && bytes.length > 3 &&
            bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    }

    /**
     * The 40-character cipher key for this volume, or a throw that says which
     * precondition is missing. Cheap enough to call per page; the token and
     * expiry it reads are refreshed by kindleApplyBookInfo().
     */
    function kindleKeyMaterial() {
        const token = kindleState.token;
        if (!token) {
            throw new Error('the Kindle reader has not published its karamel token yet — ' +
                'open the volume in the reader and let a page render, then try again');
        }
        if (token.length < 100) {
            // The viewer throws "Invalid rendering token" below 100 characters;
            // matching that keeps a truncated token from deriving a key that
            // fails later as an opaque OperationError on every page.
            throw new Error('the Kindle reader published a truncated karamel token (' +
                token.length + ' characters)');
        }
        const offset = Math.abs(Math.trunc(kindleState.expiresAt)) % 60;
        const key = token.substring(offset, offset + KINDLE_KEY_LENGTH);
        if (key.length < KINDLE_KEY_LENGTH) {
            throw new Error('the Kindle karamel token is too short to cut a ' +
                KINDLE_KEY_LENGTH + '-character key from');
        }
        return key;
    }

    async function kindleAesGcmKey(keyMaterial, salt) {
        const subtle = (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) ||
            (typeof crypto !== 'undefined' && crypto.subtle);
        if (!subtle) {
            throw new Error('WebCrypto is unavailable on this page, so an encrypted Kindle page cannot be read');
        }
        const enc = new TextEncoder();
        const base = await subtle.importKey('raw', enc.encode(keyMaterial),
            { name: 'PBKDF2' }, false, ['deriveBits', 'deriveKey']);
        return subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 1000, hash: 'SHA-256' },
            base, { name: 'AES-GCM', length: 128 }, false, ['decrypt']);
    }

    /**
     * Decrypt one framed base64 body into JPEG bytes.
     * GCM authenticates, so a wrong key, a wrong iv or a wrong additionalData
     * all fail here rather than producing a corrupt image.
     */
    async function kindleDecryptImage(bodyText, keyMaterial) {
        const text = String(bodyText || '');
        if (text.length <= KINDLE_FRAME_CHARS) {
            throw new Error('the encrypted Kindle page is too short to carry salt, iv and payload');
        }
        const salt = kindleBase64ToBytes(text.slice(0, KINDLE_SALT_CHARS));
        const iv = kindleBase64ToBytes(text.slice(KINDLE_SALT_CHARS, KINDLE_FRAME_CHARS));
        const ciphertext = kindleBase64ToBytes(text.slice(KINDLE_FRAME_CHARS));
        if (salt.length !== 16 || iv.length !== 16) {
            throw new Error('the encrypted Kindle page has a malformed salt/iv header (' +
                salt.length + '/' + iv.length + ' bytes)');
        }
        const subtle = (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) ||
            (typeof crypto !== 'undefined' && crypto.subtle);
        const enc = new TextEncoder();
        const key = await kindleAesGcmKey(keyMaterial, salt);
        const plain = await subtle.decrypt({
            name: 'AES-GCM',
            iv: iv,
            additionalData: enc.encode(keyMaterial.slice(0, KINDLE_KEY_AAD_LENGTH)),
            tagLength: 128,
        }, key, ciphertext);
        return new Uint8Array(plain);
    }

    /**
     * Is this string an actual CDN signature, or Amazon's placeholder?
     *
     * The signature does NOT always live in the same field, and the two captures
     * are exact opposites:
     *
     *   capture 1 — `cdn.authParameter` is null, and every
     *               `cdnResources[].authParameter` carries its own
     *               `Policy=…&Signature=…&Key-Pair-Id=…`
     *   capture 2 — `cdn.authParameter` carries ONE policy whose Resource is the
     *               whole `https://<host>/<asin>/<rev>/fullbook/*` prefix, and
     *               every `cdnResources[].authParameter` is the literal string
     *               `null&renderingOrigin=KRS`
     *
     * Taking the resource field on faith in the capture-2 case produces
     * `…/resource/rsrc1MT?null&renderingOrigin=KRS`, which CloudFront answers
     * 403 — the failure that shipped. So test for a signature rather than for
     * the field being populated.
     */
    function kindleLooksSigned(value) {
        const s = String(value == null ? '' : value).replace(/^\?/, '');
        if (!s || s.slice(0, 4).toLowerCase() === 'null') return false;
        return /(^|&)Signature=/.test(s) && /(^|&)(Policy|Key-Pair-Id)=/.test(s);
    }

    function kindlePickAuth(resourceAuth, cdnAuth) {
        if (kindleLooksSigned(resourceAuth)) return String(resourceAuth).replace(/^\?/, '');
        if (kindleLooksSigned(cdnAuth)) return String(cdnAuth).replace(/^\?/, '');
        return null;
    }

    /**
     * The `Resource` a signature's policy authorizes, or null if unreadable.
     *
     * This is the only trustworthy way to tell the two distributions apart, and
     * they need OPPOSITE requests: a prefix policy (`…/fullbook/*`) is the form
     * the encrypted host demands the reading-session token for, while an
     * exact-resource policy (`…/resource/rsrc9X`, every plain-host and sample URL)
     * answers 403 if the token is present at all. The viewer's own requests
     * follow exactly this split, so read it from the policy rather than guessing
     * from a host name.
     */
    function kindleAuthPolicyResource(authParameter) {
        const m = /[?&]Policy=([^&]+)/.exec('?' + String(authParameter || ''));
        if (!m) return null;
        try {
            let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
            b64 += '='.repeat((4 - (b64.length % 4)) % 4);
            const json = JSON.parse(kindleBytesToText(kindleBase64ToBytes(b64)));
            const st = json && json.Statement && json.Statement[0];
            return st && typeof st.Resource === 'string' ? st.Resource : null;
        } catch (e) {
            return null;
        }
    }
    function kindleAuthPolicyIsPrefix(authParameter) {
        const res = kindleAuthPolicyResource(authParameter);
        return res === null ? null : /\*$/.test(res);
    }

    function kindleResourceUrl(resource, options) {
        if (!resource || !resource.url) throw new Error('Kindle resource descriptor is incomplete');
        const base = String(resource.baseUrl || '').replace(/\/+$/, '');
        const path = String(resource.url).replace(/^\/+/, '');
        if (!resource.authParameter) {
            // Better a named failure than a request for "?undefined": if this
            // fires, the manifest shape changed again.
            throw new Error('the Kindle manifest carried no CDN signature for ' + path);
        }
        // The signed URL alone is NOT sufficient for every distribution, and the
        // two distributions want OPPOSITE things — so which parameters to send is
        // decided by the signature's own policy, not by a host list:
        //
        //   prefix policy (`…/fullbook/*`, the encrypted host): the reading
        //     session token is REQUIRED, and omitting it is answered with 502
        //     (not 403). token=<bookInfo.karamelToken.token> is byte-identical to
        //     what the viewer sends; expiration=karamelToken.expiresAt (epoch ms).
        //   exact-resource policy (`…/resource/rsrc9X`, every plain host and every
        //     sample URL): the token must be ABSENT. Sending it is answered with
        //     403 on a perfectly valid signature — which is what made all 109
        //     sample fetches fail while the viewer's 18 token-less ones succeeded.
        //
        // Both mistakes were made for real here, in opposite directions. An
        // unreadable policy keeps the token (the full-book case), and callers may
        // force the other form via { omitSession } so a wrong judgement costs one
        // retry rather than the run.
        let url = base + '/' + path + '?' + resource.authParameter;
        const omitSession = options && 'omitSession' in options
            ? !!options.omitSession
            : kindleAuthPolicyIsPrefix(resource.authParameter) === false;
        const sessionToken = kindleState.token;
        const sessionExpiry = Number(kindleState.expiresAt) || 0;
        if (!omitSession && sessionToken) url += '&token=' + encodeURIComponent(sessionToken);
        if (!omitSession && sessionExpiry) url += '&expiration=' + sessionExpiry;
        return url;
    }

    /**
     * Turn one fetched resource body into JPEG bytes.
     *
     * `resource.isEncrypted` describes the manifest that named the URL, and it is
     * used only to choose the *first* attempt — never as a fact about the bytes.
     * It was trusted once, and the result was pages that fetched perfectly and
     * then vanished: the body was not shaped the way the flag promised, the
     * decode threw, and the run reported them as pages that "could not be
     * fetched". Sniff instead, and when nothing fits, say what actually arrived.
     */
    async function kindleDecodeResource(bytes, resource) {
        const raw = bytes || new Uint8Array(0);
        if (!raw.length) throw new Error('the Kindle CDN returned an empty page body');
        if (kindleLooksLikeJpeg(raw)) return raw;

        const text = kindleBytesToText(raw).replace(/\s+/g, '');
        const claimsEncrypted = !!(resource && resource.isEncrypted);

        // The AES-GCM form is base64 of salt|iv|ciphertext, so it is tried first
        // when the manifest says so, and second when a body clearly is base64 but
        // the manifest said otherwise.
        const attempts = claimsEncrypted ? ['decrypt', 'base64'] : ['base64', 'decrypt'];
        const failures = [];
        for (const how of attempts) {
            try {
                const out = how === 'decrypt'
                    ? await kindleDecryptImage(text, kindleKeyMaterial())
                    : kindleBase64ToBytes(text);
                if (kindleLooksLikeJpeg(out)) return out;
                failures.push(how + ': decoded but not a JPEG');
            } catch (e) {
                failures.push(how + ': ' + safeLogText(e && e.message));
            }
        }
        const head = kindleBytesToText(raw.subarray(0, 24)).replace(/[^\x20-\x7e]/g, '.');
        throw new Error('the Kindle CDN returned something that is not a page image' +
            ' (isEncrypted=' + claimsEncrypted + ', starts with "' + head + '"; ' +
            failures.join('; ') + ')');
    }
