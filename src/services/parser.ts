import * as parsePodcast from 'node-podcast-parser'
import * as request from 'request-promise-native'
import { getRepository, In, getManager } from 'typeorm'
import { config } from '~/config'
import { Author, Category, Episode, FeedUrl, Podcast } from '~/entities'
import { deleteMessage, receiveMessageFromQueue, sendMessageToQueue
} from '~/services/queue'
import { getPodcast } from '~/controllers/podcast'

const { awsConfig } = config
const queueUrls = awsConfig.queueUrls

export const parseFeedUrl = async feedUrl => {
  const response = await request(feedUrl.url, { timeout: 15000 })

  return new Promise(async (resolve, reject) => {
    await parsePodcast(response, async (error, data) => {
      if (error) {
        console.error('Parsing error', error, feedUrl.url)
        reject()
        return
      }

      try {
        let podcast = new Podcast()
        if (feedUrl.podcast) {
          const savedPodcast = await getPodcast(feedUrl.podcast.id)
          if (!savedPodcast) throw Error('Invalid podcast id provided.')
          podcast = savedPodcast
        }

        podcast.isPublic = true

        let authors = []
        if (data.author) {
          authors = await findOrGenerateAuthors(data.author) as never
        }

        let categories = []
        if (data.categories) {
          categories = await findCategories(data.categories)
        }

        const { newEpisodes, updatedSavedEpisodes } =
          await findOrGenerateParsedEpisodes(data.episodes, podcast) as any

        let latestEpisode
        const latestNewEpisode = newEpisodes.reduce((r, a) => {
          return r.pubDate > a.pubDate ? r : a
        }, [])
        const latestUpdatedSavedEpisode = updatedSavedEpisodes.reduce((r, a) => {
          return r.pubDate > a.pubDate ? r : a
        }, [])
        latestEpisode = latestNewEpisode || latestUpdatedSavedEpisode

        podcast.lastEpisodePubDate = latestEpisode.pubDate
        podcast.lastEpisodeTitle = latestEpisode.title

        if (data.description && data.description.long) {
          podcast.description = data.description.long
        }

        podcast.feedLastUpdated = data.updated
        podcast.imageUrl = data.image
        podcast.isExplicit = !!data.explicit
        podcast.guid = data.guid
        podcast.language = data.language
        podcast.linkUrl = data.link
        podcast.title = data.title
        podcast.type = data.type

        await getManager().transaction(async transactionalEntityManager => {
          delete podcast.createdAt
          delete podcast.updatedAt
          delete podcast.episodes

          await transactionalEntityManager.save(authors)
          await transactionalEntityManager.save(categories)

          podcast.authors = authors
          podcast.categories = categories

          await transactionalEntityManager.save(podcast)

          await transactionalEntityManager
            .createQueryBuilder()
            .update(Episode)
            .set({ isPublic: false })
            .where('podcastId = :id', { id: podcast.id })

          await transactionalEntityManager.save(updatedSavedEpisodes, Episode)
          await transactionalEntityManager.save(newEpisodes, Episode)
        })

        const feedUrlRepo = await getRepository(FeedUrl)

        const cleanedFeedUrl = {
          id: feedUrl.id,
          url: feedUrl.url,
          podcast
        }

        await feedUrlRepo.update(feedUrl.id, cleanedFeedUrl)

        resolve()
      } catch (error) {
        throw error
      }
    })
  })
}

export const parsePublicFeedUrls = async () => {
  const repository = getRepository(FeedUrl)

  let qb = repository
    .createQueryBuilder('feedUrl')
    .select('feedUrl.id')
    .addSelect('feedUrl.url')
    .leftJoinAndSelect(
      'feedUrl.podcast',
      'podcast',
      'podcast.isPublic = :isPublic',
      {
        isPublic: true
      }
    )
    .leftJoinAndSelect('podcast.episodes', 'episodes')
    .where('feedUrl.isAuthority = true AND feedUrl.podcast IS NOT NULL')

  try {
    const feedUrls = await qb.getMany()

    for (const feedUrl of feedUrls) {
      await parseFeedUrl(feedUrl)
    }

    return
  } catch (error) {
    console.log(error)
  }
}

export const parseOrphanFeedUrls = async () => {
  const repository = getRepository(FeedUrl)

  let qb = repository
    .createQueryBuilder('feedUrl')
    .select('feedUrl.id')
    .addSelect('feedUrl.url')
    .leftJoinAndSelect('feedUrl.podcast', 'podcast')
    .where('feedUrl.isAuthority = true AND feedUrl.podcast IS NULL')

  try {
    const feedUrls = await qb.getMany()

    for (const feedUrl of feedUrls) {
      await parseFeedUrl(feedUrl)
    }

    return
  } catch (error) {
    console.log(error)
  }
}

export const parseFeedUrlsFromQueue = async (priority, restartTimeOut) => {
  const shouldContinue = await parseNextFeedFromQueue(priority)
  if (shouldContinue) {
    await parseFeedUrlsFromQueue(priority, restartTimeOut)
  } else if (restartTimeOut) {
    // @ts-ignore
    setTimeout(() => {
      parseFeedUrlsFromQueue(priority, restartTimeOut)
    }, restartTimeOut)
  }
}

export const parseNextFeedFromQueue = async priority => {
  const queueUrl = queueUrls.feedsToParse.priority[priority].queueUrl
  const errorsQueueUrl = queueUrls.feedsToParse.priority[priority].errorsQueueUrl
  const message = await receiveMessageFromQueue(queueUrl)

  if (!message) {
    return false
  }

  const feedUrlMsg = extractFeedMessage(message)

  try {
    const feedUrlRepo = await getRepository(FeedUrl)

    let feedUrl = await feedUrlRepo
      .createQueryBuilder('feedUrl')
      .select('feedUrl.id')
      .addSelect('feedUrl.url')
      .leftJoinAndSelect(
        'feedUrl.podcast',
        'podcast'
      )
      .leftJoinAndSelect('podcast.episodes', 'episodes')
      .where('feedUrl.id = :id', { id: feedUrlMsg.id })
      .getOne()

    if (feedUrl) {
      await parseFeedUrl(feedUrl)
    } else {
      await parseFeedUrl(feedUrlMsg)
    }

  } catch (error) {
    console.error('parseNextFeedFromQueue:parseFeed', error)
    const attrs = generateFeedMessageAttributes(feedUrlMsg)
    await sendMessageToQueue(attrs, errorsQueueUrl)
  }

  await deleteMessage(priority, feedUrlMsg
    .receiptHandle)

  return true
}

const findOrGenerateAuthors = async (authorNames) => {
  const authorRepo = await getRepository(Author)
  let allAuthorNames = authorNames.split(',').map(x => x.trim())

  const existingAuthors = await authorRepo.find({
    where: {
      name: In(allAuthorNames)
    }
  })

  let newAuthors = []
  let existingAuthorNames = existingAuthors.map(x => x.name)
  let newAuthorNames = allAuthorNames.filter(x => !existingAuthorNames.includes(x))

  for (const name of newAuthorNames) {
    let author = generateAuthor(name) as never
    newAuthors.push(author)
  }

  const allAuthors = existingAuthors.concat(newAuthors)

  return allAuthors
}

const generateAuthor = name => {
  let author = new Author()
  author.name = name
  return author
}

const findCategories = async categories => {
  const categoryRepo = await getRepository(Category)
  categories = await categoryRepo.find({
    where: {
      title: In(categories)
    }
  })
  return categories
}

const assignParsedEpisodeData = async (episode, parsedEpisode, podcast) => {
  episode.isPublic = true
  episode.description = parsedEpisode.description
  episode.duration = parsedEpisode.duration
    ? parseInt(parsedEpisode.duration, 10) : 0
  episode.episodeType = parsedEpisode.episodeType
  episode.guid = parsedEpisode.guid
  episode.imageUrl = parsedEpisode.image
  episode.isExplicit = parsedEpisode.explicit
  episode.mediaFilesize = parsedEpisode.enclosure.filesize
    ? parseInt(parsedEpisode.enclosure.filesize, 10) : 0
  episode.mediaType = parsedEpisode.enclosure.type
  episode.mediaUrl = parsedEpisode.enclosure.url
  episode.pubDate = parsedEpisode.published
  episode.title = parsedEpisode.title

  let authors = []
  if (parsedEpisode.author) {
    authors = await findOrGenerateAuthors(parsedEpisode.author) as never[]
  }
  episode.authors = authors

  let categories = []
  if (parsedEpisode.categories) {
    categories = await findCategories(parsedEpisode.categories)
  }
  episode.categories = categories

  episode.podcast = podcast

  return episode
}

const findOrGenerateParsedEpisodes = async (parsedEpisodes, podcast) => {
  const episodeRepo = await getRepository(Episode)

  // Parsed episodes are only valid if they have enclosure.url tags,
  // so ignore all that do not.
  const validParsedEpisodes = parsedEpisodes.reduce((result, x) => {
    if (x.enclosure && x.enclosure.url) {
      result.push(x)
    }
    return result
  }, [])
  // Create an array of only the episode media URLs from the parsed object
  const parsedEpisodeMediaUrls = validParsedEpisodes.map(x => x.enclosure.url)

  // Find episodes in the database that have matching episode media URLs to
  // those found in the parsed object, then store an array of just those URLs.
  const savedEpisodes = await episodeRepo.find({
    where: {
      mediaUrl: In(parsedEpisodeMediaUrls)
    }
  })

  const savedEpisodeMediaUrls = savedEpisodes.map(x => x.mediaUrl)

  // Create an array of only the parsed episodes that do not have a match
  // already saved in the database.
  const newParsedEpisodes = validParsedEpisodes.filter(
    x => !savedEpisodeMediaUrls.includes(x.enclosure.url)
  )

  const updatedSavedEpisodes = []
  const newEpisodes = []
  // If episode is already saved, then merge the matching episode found in
  // the parsed object with what is already saved.
  for (let existingEpisode of savedEpisodes) {
    let parsedEpisode = validParsedEpisodes.find(
      x => x.enclosure.url === existingEpisode.mediaUrl
    )
    existingEpisode = await assignParsedEpisodeData(existingEpisode, parsedEpisode, podcast)
    // @ts-ignore
    updatedSavedEpisodes.push(existingEpisode)
  }

  // If episode from the parsed object is new (not already saved),
  // then create a new episode.
  for (const newParsedEpisode of newParsedEpisodes) {
    let episode = new Episode()
    episode = await assignParsedEpisodeData(episode, newParsedEpisode, podcast)
    // @ts-ignore
    newEpisodes.push(episode)
  }

  return {
    updatedSavedEpisodes,
    newEpisodes
  }
}

export const generateFeedMessageAttributes = feedUrl => {
  return {
    'id': {
      DataType: 'String',
      StringValue: feedUrl.id
    },
    'url': {
      DataType: 'String',
      StringValue: feedUrl.url
    },
    ...(feedUrl.podcast && feedUrl.podcast.id ? {
      'podcastId': {
        DataType: 'String',
        StringValue: feedUrl.podcast && feedUrl.podcast.id
      }
    } : {}),
    ...(feedUrl.podcast && feedUrl.podcast.title ? {
      'podcastTitle': {
        DataType: 'String',
        StringValue: feedUrl.podcast && feedUrl.podcast.title
      }
    } : {})
  }
}

const extractFeedMessage = message => {
  const attrs = message.MessageAttributes
  return {
    id: attrs.id.StringValue,
    url: attrs.url.StringValue,
    ...(attrs.podcastId && attrs.podcastTitle ? {
      podcast: {
        id: attrs.podcastId.StringValue,
        title: attrs.podcastTitle.StringValue
      }
    } : {}),
    receiptHandle: message.ReceiptHandle
  } as any
}
