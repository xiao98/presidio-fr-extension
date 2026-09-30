// Let content scripts use chrome.storage.session: the vault survives a page reload and dies with the browser.
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
