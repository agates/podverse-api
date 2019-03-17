import { config } from '~/config'
import { createTransporter } from '~/services/mailer'
import { emailTemplate } from '~/lib/emailTemplate'
const createError = require('http-errors')

const { mailerUsername } = config

export const sendVerificationEmail = async (email, name, token) => {
  const transporter = createTransporter()

  const emailFields = {
    preheader: '',
    greeting: `${name ? `Hi ${name},` : 'Hello podcast fan,'}`,
    topMessage: 'Please click the button below to verify your email address with podverse.fm.',
    button: 'Verify Email',
    buttonLink: `${config.websiteProtocol}://${config.websiteDomain}${config.websiteVerifyEmailPagePath}${token}`,
    bottomMessage: `We will never share your email or data without your permission.`,
    closing: 'Have a nice day :)',
    name: '',
    address: '',
    unsubscribeLink: '',
    buttonColor: '#2968B1'
  }

  try {
    await transporter.sendMail({
      from: `Podverse <${mailerUsername}>`,
      to: email,
      subject: 'Verify your Podverse account',
      html: emailTemplate(emailFields)
    })
  } catch (error) {
    throw new createError.InternalServerError(error)
  }
}
