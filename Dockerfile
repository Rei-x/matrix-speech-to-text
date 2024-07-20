# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1-alpine AS base
RUN apk --no-cache add libstdc++ curl
USER bun

WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install

WORKDIR /temp/prod
COPY package.json bun.lockb /temp/prod/
RUN bun install --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY . .

ENV NODE_ENV=production

FROM base AS release

COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/index.ts .
COPY --from=prerelease /usr/src/app/package.json .
RUN mkdir -p /usr/src/app/db

EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "index.ts" ]
