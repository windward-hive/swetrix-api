import { Entity, Column, PrimaryGeneratedColumn, OneToMany, BeforeUpdate } from 'typeorm'
import { ActionToken } from 'src/action-tokens/action-token.entity'
import { Project } from 'src/project/entity/project.entity'

export const ACCOUNT_PLANS = {
  free: {
    displayName: 'Free plan',
    monthlyUsageLimit: 5000,
    maxProjects: 10,
  },
  freelancer: {
    displayName: 'Freelancer plan',
    monthlyUsageLimit: 100000,
    maxProjects: 20,
    priceId: 'price_1JORmHCQYBdiXzBatNEKQmP9',
  },
  startup: {
    displayName: 'Startup plan',
    monthlyUsageLimit: 500000,
    maxProjects: 20,
    priceId: 'price_1JORmfCQYBdiXzBawbn1yoeu',
  },
  enterprise: {
    displayName: 'Enterprise plan',
    monthlyUsageLimit: 1000000,
    maxProjects: 30,
    priceId: 'price_1JORn3CQYBdiXzBaOdcNvHHP',
  },
}

export enum PlanCode {
  free = 'free',
  freelancer = 'freelancer',
  startup = 'startup',
  enterprise = 'enterprise',
}

export enum UserType {
  CUSTOMER = 'customer',
  ADMIN = 'admin',
}

export enum ReportFrequency {
  Never = 'never',
  Weekly = 'weekly',
  Monthly = 'monthly'
}

export const MAX_EMAIL_REQUESTS = 4 // 1 confirmation email on sign up + 3 additional ones

@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({
    type: 'set',
    enum: UserType,
    default: UserType.CUSTOMER,
  })
  roles: UserType[]

  @Column({
    type: 'enum',
    enum: PlanCode,
    default: PlanCode.free,
  })
  planCode: PlanCode

  @Column('varchar', { length: 254, unique: true })
  email: string

  @Column('varchar', { length: 60, default: '' })
  password: string

  @Column({ default: false })
  isActive: boolean

  @Column({
    type: 'enum',
    enum: ReportFrequency,
    default: ReportFrequency.Monthly,
  })
  reportFrequency: ReportFrequency

  @Column('int', { default: 1 })
  emailRequests: number

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  created: Date

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updated: Date

  @Column({ type: 'timestamp', nullable: true })
  exportedAt: Date

  @Column('varchar', { length: 28, nullable: true })
  stripeSubID: string

  @BeforeUpdate()
  updateTimestamp() {
    this.updated = new Date
  }

  // @Column('datetime', { nullable: true, default: null })
  // consent: Date

  @OneToMany(() => Project, project => project.admin)
  projects: Project[]

  @OneToMany(() => ActionToken, actionToken => actionToken.user)
  actionTokens: ActionToken[]
}
