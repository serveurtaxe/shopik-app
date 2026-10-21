import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getWwwRedirect } from '../../server/middleware/redirectWww.js'

const roots = new Set(['shopik.co.il'])

describe('www redirect', () => {
    it('redirects www to the bare configured domain', () => {
        assert.equal(getWwwRedirect('www.shopik.co.il', roots), 'shopik.co.il')
    })

    it('redirects www.admin to admin', () => {
        assert.equal(getWwwRedirect('www.admin.shopik.co.il', roots), 'admin.shopik.co.il')
    })

    it('preserves a port', () => {
        assert.equal(getWwwRedirect('www.shopik.co.il:8443', roots), 'shopik.co.il:8443')
    })

    it('is case-insensitive', () => {
        assert.equal(getWwwRedirect('WWW.Shopik.CO.IL', roots), 'shopik.co.il')
    })

    it('does not redirect non-www hosts', () => {
        assert.equal(getWwwRedirect('shopik.co.il', roots), null)
        assert.equal(getWwwRedirect('admin.shopik.co.il', roots), null)
    })

    it('does not redirect unknown or non-storefront hosts (open-redirect guard)', () => {
        assert.equal(getWwwRedirect('www.evil.com', roots), null)
        assert.equal(getWwwRedirect('www.foo.shopik.co.il', roots), null)
        assert.equal(getWwwRedirect('www.shopik.co.il.evil.com', roots), null)
        assert.equal(getWwwRedirect('www.files.shopik.co.il', roots), null)
    })

    it('ignores malformed hosts', () => {
        assert.equal(getWwwRedirect('www.', roots), null)
        assert.equal(getWwwRedirect('', roots), null)
    })
})
