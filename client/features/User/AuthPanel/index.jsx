import DigitsInput from 'common/components/DigitsInput'
import Checkbox from 'common/components/Checkbox'
import Button from 'common/components/Button'
import apiReq from 'common/functions/apiReq'
import events from '#common/features/events'
import Input from 'common/components/Input'
import Title from 'common/components/Title'
import styles from './authPanel.module.css'
import Icon from '#common/components/Icon'
import Flex from 'common/components/Flex'
import Form from 'common/components/Form'
import Text from 'common/components/Text'
import { useUser } from 'features/User'
import { useState } from 'react'
import Account from 'pages/Account'

/**
 * Shared login/register panel — rendered inside the desktop Popover
 * (via UserView) and inline in the mobile menu drawer. `remember`
 * (30-day session) flows through Form values into all three auth calls.
 */
export default function AuthPanel({ onClose }) {
    const user = useUser()
    const [tab, setTab] = useState('login')

    if (user?.id)
        return <Flex gap={20} col className={styles.authPanel}>
            <Account onClose={onClose} />
        </Flex>

    return <Flex gap={16} col className={styles.authPanel}>
        <Flex gap={8} className={styles.tabs}>
            <Button
                type='button'
                mode={tab === 'login' ? 'outline' : 'text'}
                className={styles.tabBtn}
                onClick={() => setTab('login')}
            >
                login
            </Button>
            <Button
                type='button'
                mode={tab === 'register' ? 'outline' : 'text'}
                className={styles.tabBtn}
                onClick={() => setTab('register')}
            >
                register
            </Button>
        </Flex>

        {tab === 'login'
            ? <LoginForm onClose={onClose} onToRegister={() => setTab('register')} />
            : <RegisterForm onClose={onClose} onToLogin={() => setTab('login')} />}
    </Flex>
}

function AuthHero({ icon = 'door', title = 'web_login_title', subtitle = 'web_login_subTitle' }) {
    return <Flex col center gap={8} className={styles.hero}>
        <span className={styles.heroIcon}>
            <Icon name={icon} />
        </span>
        <Title subtitle={subtitle}>{title}</Title>
    </Flex>
}

function RememberRow() {
    return <Checkbox
        name='remember'
        defaultChecked
        className={styles.remember}
    >
        <Text size='s'>login_remember_30</Text>
    </Checkbox>
}

function LoginForm({ onClose, onToRegister }) {
    const
        [step, setStep] = useState(1),
        [otpToken, setOtpToken] = useState(''),
        [phone, setPhone] = useState(''),
        [remember, setRemember] = useState(true),
        [error, setError] = useState('')

    async function handleRequestOtp(vals) {
        setError('')
        try {
            const targetPhone = vals?.phone || phone
            const res = await apiReq('user/login_otp', { phone: targetPhone, remember: vals?.remember === true })
            setOtpToken(res.token)
            if (vals?.phone) setPhone(vals.phone)
            setRemember(vals?.remember === true)
            setStep(2)
        } catch (err) {
            setError(err.message || err)
        }
    }

    if (step === 2) {
        return <DigitsInputStep
            phone={phone}
            otpToken={otpToken}
            remember={remember}
            onClose={onClose}
            onResend={() => handleRequestOtp()}
            onBack={() => setStep(1)}
            submitText='login'
        />
    }

    return <>
        <AuthHero />
        <Form action={handleRequestOtp} error={error} submitText='send_otp' className={styles.form}>
            <Flex col gap={4}>
                <Input
                    name='phone'
                    type='tel'
                    title='login_phone_label'
                    placeholder='login_phone_placeholder'
                    defaultValue={phone}
                    required
                    autoFocus
                    className={styles.phoneInput}
                />
            </Flex>
            <RememberRow />
        </Form>
        <Flex center gap={5}>
            <Text>no_account_question</Text>
            <Button type='button' mode='text-brand' onClick={onToRegister}>to_register</Button>
        </Flex>
    </>
}

function RegisterForm({ onClose, onToLogin }) {
    const
        [step, setStep] = useState(1),
        [phone, setPhone] = useState(''),
        [otpToken, setOtpToken] = useState(''),
        [remember, setRemember] = useState(true),
        [error, setError] = useState('')

    async function handleRequestOtp(data) {
        setError('')
        try {
            const res = await apiReq('user/register', { ...data, remember: data?.remember === true })
            setOtpToken(res.token)
            setPhone(data.phone)
            setRemember(data?.remember === true)
            setStep(2)
        } catch (err) {
            setError(err.message || err)
        }
    }

    if (step === 2) {
        return <DigitsInputStep
            title='web_register_title'
            phone={phone}
            otpToken={otpToken}
            remember={remember}
            onClose={onClose}
            onResend={() => handleRequestOtp()}
            onBack={() => setStep(1)}
            submitText='register'
        />
    }

    return <>
        <AuthHero icon='circleUser' title='web_register_title' subtitle='web_register_phone_subTitle' />
        <Form action={handleRequestOtp} error={error} submitText='send_otp' className={styles.form}>
            <Flex col gap={10}>
                <Input
                    name='phone'
                    type='tel'
                    title='login_phone_label'
                    placeholder='login_phone_placeholder'
                    required
                    autoFocus
                    className={styles.phoneInput}
                />
                <Input name='name.first' />
                <Input name='name.last' />
            </Flex>
            <RememberRow />
        </Form>
        <Flex center gap={5}>
            <Text>have_account_question</Text>
            <Button type='button' mode='text-brand' onClick={onToLogin}>to_login</Button>
        </Flex>
    </>
}

function DigitsInputStep({ title = 'web_login_title', subtitle = 'web_login_subTitle_otp', phone, otpToken, remember, onClose, onResend, onBack, submitText }) {
    const { onLogin } = useUser()
    const [error, setError] = useState('')
    const [resent, setResent] = useState(false)

    async function handleLogin(vals) {
        setError('')
        try {
            const user = await apiReq('user/login', { phone, otpToken, otp: vals.otp, remember })
            onLogin(user)
            onClose?.()
            events.emit('delivery-popover')
        } catch (err) {
            setError(err.message || err)
            throw err
        }
    }

    async function resendCode() {
        try {
            setError('')
            await onResend()
            setResent(true)
        } catch (err) {
            setError(err.message || err)
            setResent(false)
        }
    }

    return <>
        <Form action={handleLogin} error={error} submitText={submitText} className={styles.form}>
            <Button type='button' mode='text-brand' icon='back' onClick={onBack} style={{ marginBottom: -15 }}>back</Button>
            <Title subtitle={subtitle}>{title}</Title>
            <Flex col gap={10}>
                <DigitsInput name='otp' onCodeComplete={otp => handleLogin({ otp })} />
            </Flex>
        </Form>
        {resent ? '' : <Flex center gap={5}>
            <Text>did_not_receive_code</Text>
            <Button type='button' mode='text-brand' onClick={resendCode}>send_again</Button>
        </Flex>}
    </>
}
