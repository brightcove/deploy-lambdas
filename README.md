deploy-lambdas
===
Lambda(s) to help with deploys.
The scripts themselves will contain implementation information using
[JsDoc](http://usejsdoc.org/), user-type information will be added to the
[wiki](https://github.com/brightcove/deploy-lambdas/wiki).

Questions?
[Open an issue](https://github.com/brightcove/deploy-lambdas/issues/new)
with the question label

Installation
---
Right now nothing too fancy...generate zips which can be uploaded to Lambda.
`npm` is used for a build system, to generate zip file(s) run:

```
npm dist
```

and then do whatever with the created zips in the dist folder.
