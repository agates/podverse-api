const Joi = require('joi')
import { validateBaseBody } from './base'

const validateMediaRefUpdate = async (ctx, next) => {
  const schema = Joi.object().keys({
    endTime: Joi.number().integer().min(1).allow(null),
    id: Joi.string().min(7).max(14).required(),
    isPublic: Joi.boolean(),
    startTime: Joi.number().integer().min(0).required(),
    title: Joi.string().allow(null)
  })

  await validateBaseBody(schema, ctx, next)
}

const validatePlaylistUpdate = async (ctx, next) => {
  const schema = Joi.object().keys({
    description: Joi.string().allow(null),
    id: Joi.string().min(7).max(14).required(),
    isPublic: Joi.boolean(),
    itemsOrder: Joi.array().items(Joi.string()),
    mediaRefs: Joi.array().items(Joi.string()),
    ownerId: Joi.string().required(),
    title: Joi.string().allow(null)
  })

  await validateBaseBody(schema, ctx, next)
}

const validateUserUpdate = async (ctx, next) => {
  const schema = Joi.object().keys({
    email: Joi.string(),
    id: Joi.string().min(7).max(14).required(),
    name: Joi.string().allow(null),
    ownerId: Joi.string().required(),
    playlists: Joi.array().items(Joi.string()),
    subscribedPodcastIds: Joi.array().items(Joi.string())
  })

  await validateBaseBody(schema, ctx, next)
}

export {
  validateMediaRefUpdate,
  validatePlaylistUpdate,
  validateUserUpdate
}