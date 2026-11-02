# Changelog

## [0.4.0](https://github.com/danjam/pinnery/compare/v0.3.0...v0.4.0) (2026-11-02)


### Features

* link the version in Settings to the GitHub repo ([#119](https://github.com/danjam/pinnery/issues/119)) ([b1fb5aa](https://github.com/danjam/pinnery/commit/b1fb5aaea6ef4249d80f0dfd05c753fcf63260df))
* push board and pin changes to open pages ([#132](https://github.com/danjam/pinnery/issues/132)) ([c167ea4](https://github.com/danjam/pinnery/commit/c167ea42f52b5b01fe6561b16d49bf0ba7b28e13))
* window the board grid so only nearby tiles are rendered ([#133](https://github.com/danjam/pinnery/issues/133)) ([6172e3a](https://github.com/danjam/pinnery/commit/6172e3af0dad943cb96ead2d3e3664bf8ae6ad4d))


### Bug Fixes

* accept AVIF uploads, which sharp reports as HEIF ([#113](https://github.com/danjam/pinnery/issues/113)) ([412b463](https://github.com/danjam/pinnery/commit/412b4635d14e6133390eb31f38ed65f4d1ffcd8d))
* cap zip entry, bulk id and image pixel sizes ([#108](https://github.com/danjam/pinnery/issues/108)) ([95a7fd0](https://github.com/danjam/pinnery/commit/95a7fd03d33813bd1d1268bfa3923a9da05d31fb))
* clear leftover import files at startup ([#120](https://github.com/danjam/pinnery/issues/120)) ([b3964a6](https://github.com/danjam/pinnery/commit/b3964a6fa5f757fbafaee20cbea559868a7c3b10))
* don't leak internal details in fetch errors and referrers ([#106](https://github.com/danjam/pinnery/issues/106)) ([e5dea7e](https://github.com/danjam/pinnery/commit/e5dea7eb10327665dd9349a9bf1701e95e743fd6))
* export libraries past 4 GiB or 65,535 files as zip64 ([#116](https://github.com/danjam/pinnery/issues/116)) ([6e03db3](https://github.com/danjam/pinnery/commit/6e03db3524691ce7f261dc479138a55aeb76ca68))
* fit tall images on screen in the lightbox ([#131](https://github.com/danjam/pinnery/issues/131)) ([460cd41](https://github.com/danjam/pinnery/commit/460cd41fa1d218cc14ea2d90a246f5f8043a08eb))
* hash passwords off the event loop ([#126](https://github.com/danjam/pinnery/issues/126)) ([2f6008e](https://github.com/danjam/pinnery/commit/2f6008e5cbe10fdb0d04af585206b4e764619d90))
* ignore cookies that fail to decode ([#105](https://github.com/danjam/pinnery/issues/105)) ([2e8a895](https://github.com/danjam/pinnery/commit/2e8a895fcfd89a9956b0ccf01503d606f050dc47))
* keep a pin's original when a delete races its save ([#117](https://github.com/danjam/pinnery/issues/117)) ([a88e6b8](https://github.com/danjam/pinnery/commit/a88e6b8bdb192d005613fdc572c3ce580120ebc3))
* leave the board unchanged when a PATCH is rejected ([#115](https://github.com/danjam/pinnery/issues/115)) ([4c78007](https://github.com/danjam/pinnery/commit/4c7800708fabb10985c01cb3a664606395efe7fe))
* mask emails in the share directory for non-admins ([#112](https://github.com/danjam/pinnery/issues/112)) ([468be6b](https://github.com/danjam/pinnery/commit/468be6bb74e07099f7e5d3f9a4fb0b69b7f3dc12))
* only accept http(s) source URLs ([#109](https://github.com/danjam/pinnery/issues/109)) ([a9947ca](https://github.com/danjam/pinnery/commit/a9947ca8134491888bc64aa420915474b66c7d6e))
* prune expired sign-in failure counters ([#122](https://github.com/danjam/pinnery/issues/122)) ([aea2266](https://github.com/danjam/pinnery/commit/aea226653e7ee787445f7b5dc0bc3b3e365626fb))
* refresh a session's last_used_at at most once a minute ([#123](https://github.com/danjam/pinnery/issues/123)) ([cddd4e8](https://github.com/danjam/pinnery/commit/cddd4e83fdcb4d7fcf8c654d1826cc9057ef0b42))
* refuse cross-site writes on cookie-authenticated requests ([#110](https://github.com/danjam/pinnery/issues/110)) ([5a8cb82](https://github.com/danjam/pinnery/commit/5a8cb82ec61f7424ee1b86b52d1b5a6b41f60423))
* release the import lock before replying to an import ([#129](https://github.com/danjam/pinnery/issues/129)) ([be57a6f](https://github.com/danjam/pinnery/commit/be57a6f4d6f269c760209d16a49c70b7e7566470))
* stop one user's pending picks evicting another's ([#114](https://github.com/danjam/pinnery/issues/114)) ([001deee](https://github.com/danjam/pinnery/commit/001deee8225c2fca218bdfda0a2f67bf7ec983ed))
* tell the old address about an email change and cancel its reset links ([#107](https://github.com/danjam/pinnery/issues/107)) ([02160b8](https://github.com/danjam/pinnery/commit/02160b8a27c7ddaf72389f82d18689cc84862ebc))


### Performance Improvements

* build the extension zip once and serve the cached copy ([#121](https://github.com/danjam/pinnery/issues/121)) ([3e28f48](https://github.com/danjam/pinnery/commit/3e28f4822c6177564159e8d5f75181cf6dd7fbe8))
* compress responses with brotli or gzip ([#125](https://github.com/danjam/pinnery/issues/125)) ([fb9f240](https://github.com/danjam/pinnery/commit/fb9f240ed7037f46b3f26df5215fcf1d9e7a1103))
* load board covers in the board list query ([#124](https://github.com/danjam/pinnery/issues/124)) ([a9f0d18](https://github.com/danjam/pinnery/commit/a9f0d18f9a5f2e580c610eac6658a75495cc8417))
* prepare SQL statements once instead of per request ([#127](https://github.com/danjam/pinnery/issues/127)) ([8d1b382](https://github.com/danjam/pinnery/commit/8d1b3823e8c9f245f2cb693cf22d495716b8fc82))
* use async file I/O and zlib in export and import ([#128](https://github.com/danjam/pinnery/issues/128)) ([36e0eeb](https://github.com/danjam/pinnery/commit/36e0eeb7258d0aea4c741484b799cac329fb4aec))

## [0.3.0](https://github.com/danjam/pinnery/compare/v0.2.0...v0.3.0) (2026-11-01)


### Features

* rewrite Pinnery in TypeScript (server, web app and extension) ([1dcd448](https://github.com/danjam/pinnery/commit/1dcd44839b23cb046ac3e71b2b266b81e30eb22b))
* track the schema version and refuse databases from a newer Pinnery ([#77](https://github.com/danjam/pinnery/issues/77)) ([7a64d5e](https://github.com/danjam/pinnery/commit/7a64d5e839041ccc4aa476d01d2dbaf7be3b6aa7))


### Bug Fixes

* allow-list URL schemes in the extension's content script ([#71](https://github.com/danjam/pinnery/issues/71)) ([960ce9f](https://github.com/danjam/pinnery/commit/960ce9fe5098d04ff8b6a297d59ee702f5d52915))
* cap requests at 1000 a minute per client ([#57](https://github.com/danjam/pinnery/issues/57)) ([24adee0](https://github.com/danjam/pinnery/commit/24adee00809adef62ae5c956e9fd725e439abd3f))
* **deps:** update dependency node to v26 ([#52](https://github.com/danjam/pinnery/issues/52)) ([1aceab6](https://github.com/danjam/pinnery/commit/1aceab6d36d22c26a1b4259740b12ed208dd0bd2))
* ship LICENSE and NOTICE in the image ([#63](https://github.com/danjam/pinnery/issues/63)) ([d7e66fd](https://github.com/danjam/pinnery/commit/d7e66fd146095040aed9022e832e7d87a2bbd4cf))
* stop showing "false" in a viewer's board header ([#54](https://github.com/danjam/pinnery/issues/54)) ([e461576](https://github.com/danjam/pinnery/commit/e461576262983d64cb30f1af7b5cb6926f790578))

## [0.2.0](https://github.com/danjam/pinnery/compare/v0.1.0...v0.2.0) (2026-11-01)


### Features

* add PINNERY_PROXIES for the number of reverse proxies in front ([#14](https://github.com/danjam/pinnery/issues/14)) ([f4cad65](https://github.com/danjam/pinnery/commit/f4cad65246d2b3cd73dd552bce06b4d6b0386ab5))
* harden the image: distroless runtime, clean shutdown, built-in healthcheck ([#30](https://github.com/danjam/pinnery/issues/30)) ([3c0decc](https://github.com/danjam/pinnery/commit/3c0decc0edcc2dd8384ba85944498881eff63cd2))
* publish arm64 images alongside amd64 ([#20](https://github.com/danjam/pinnery/issues/20)) ([0eae415](https://github.com/danjam/pinnery/commit/0eae41512064d6c6320f03e5a5d0e1e09bb2a271))
* security headers, and close the ?next= open redirect ([#33](https://github.com/danjam/pinnery/issues/33)) ([056e6d7](https://github.com/danjam/pinnery/commit/056e6d7c662f78388d6be3e479663487a5d770bd))


### Bug Fixes

* **deps:** update dependency nodemailer to v10.3.1 ([#17](https://github.com/danjam/pinnery/issues/17)) ([1b6f3be](https://github.com/danjam/pinnery/commit/1b6f3be04f0bc2b6d9eccc911dd964f90a3322dd))
* exit with an error when the port can't be bound ([#12](https://github.com/danjam/pinnery/issues/12)) ([f477de8](https://github.com/danjam/pinnery/commit/f477de814768ae4d98020c8b21d59d494482d144))
* stop reset-link poisoning and two slow regexes ([#37](https://github.com/danjam/pinnery/issues/37)) ([4cfbef8](https://github.com/danjam/pinnery/commit/4cfbef8843f6ce6296f18155bfffe504d1f947fc))

## 0.1.0 (2026-11-01)


### Features

* initial release ([36f1cf9](https://github.com/danjam/pinnery/commit/36f1cf9727c6cab308b5c92376e7576c690d4130))
