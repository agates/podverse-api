import * as Router from 'koa-router'
import { config } from '~/config'
import { emitRouterError } from '~/lib/errors'
import {
  getPodcastFromPodcastIndexById,
  getValueTagForChannelFromPodcastIndexByGuids,
  getValueTagForItemFromPodcastIndexByGuids
} from '~/services/podcastIndex'
const RateLimit = require('koa2-ratelimit').RateLimit
const { rateLimiterMaxOverride } = config

const router = new Router({ prefix: `${config.apiPrefix}${config.apiVersion}/podcast-index` })

const podcastByIdLimiter = RateLimit.middleware({
  interval: 1 * 60 * 1000,
  max: rateLimiterMaxOverride || 100,
  message: `You're doing that too much. Please try again in a minute.`,
  prefixKey: 'get/podcast-index/by-id'
})

// Get podcast from Podcast Index by feed id
router.get('/podcast/by-id/:id', podcastByIdLimiter, async (ctx) => {
  try {
    const data = await getPodcastFromPodcastIndexById(ctx.params.id)
    ctx.body = data
  } catch (error) {
    emitRouterError(error, ctx)
  }
})

// Get value tags from Podcast Index by feed and item guids.
router.get('/value/by-guids', async (ctx) => {
  const podcastGuid = ctx.query.podcastGuid as string
  const episodeGuid = ctx.query.episodeGuid as string

  if (podcastGuid && episodeGuid) {
    try {
      const data = await getValueTagForItemFromPodcastIndexByGuids(podcastGuid, episodeGuid)
      ctx.body = data
    } catch (error) {
      console.log('error', error)
      emitRouterError(error, ctx)
    }
  } else if (podcastGuid) {
    try {
      const data = await getValueTagForChannelFromPodcastIndexByGuids(ctx.params.podcastGuid)
      ctx.body = data
    } catch (error) {
      emitRouterError(error, ctx)
    }
  }
})

export const podcastIndexRouter = router
