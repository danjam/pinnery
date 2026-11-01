# Changelog

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
