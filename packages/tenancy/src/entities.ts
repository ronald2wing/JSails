/**
 * Framework-owned tenant entities.
 *
 * The tenancy plugin owns the default tenant/membership tables. They are never
 * added to an application's schema unless the plugin is enabled and discovered
 * by the schema command. Membership references an opaque Better Auth-compatible
 * user id; it deliberately has no foreign key to the auth package's user table.
 */

import {
  BaseEntity,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** A tenant/workspace. */
@Entity('jsails_tenants')
export class Tenant extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 190, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status!: string;

  /** Application-specific tenant settings; validated by the app when written. */
  @Column({ type: 'json', nullable: true })
  metadata!: Record<string, unknown> | null;
}

/** A user's membership in one tenant. */
@Entity('jsails_tenant_memberships')
@Index('jsails_tenant_memberships_tenant_user_unique', ['tenant', 'userId'], {
  unique: true,
})
export class TenantMembership extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  /** Opaque actor/user id; Better Auth ids fit the default varchar(190). */
  @Column({ name: 'user_id', type: 'varchar', length: 190 })
  userId!: string;

  @Column({ type: 'varchar', length: 50, default: 'member' })
  role!: string;
}

/** The entities the tenancy plugin owns. */
export const tenancyEntities = Object.freeze([Tenant, TenantMembership]);
