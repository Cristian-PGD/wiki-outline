import fs from "fs";
import path from "path";
import { URL } from "url";
import util from "util";
import { Op } from "sequelize";
import {
  Column,
  IsLowercase,
  NotIn,
  Default,
  Table,
  Unique,
  IsIn,
  HasMany,
  Scopes,
  Is,
  DataType,
  IsUUID,
  IsUrl,
  AllowNull,
  AfterUpdate,
} from "sequelize-typescript";
import { CollectionPermission, TeamPreference } from "@shared/types";
import { getBaseDomain, RESERVED_SUBDOMAINS } from "@shared/utils/domains";
import env from "@server/env";
import DeleteAttachmentTask from "@server/queues/tasks/DeleteAttachmentTask";
import { generateAvatarUrl } from "@server/utils/avatars";
import parseAttachmentIds from "@server/utils/parseAttachmentIds";
import Attachment from "./Attachment";
import AuthenticationProvider from "./AuthenticationProvider";
import Collection from "./Collection";
import Document from "./Document";
import TeamDomain from "./TeamDomain";
import User from "./User";
import ParanoidModel from "./base/ParanoidModel";
import Fix from "./decorators/Fix";
import IsFQDN from "./validators/IsFQDN";
import Length from "./validators/Length";
import NotContainsUrl from "./validators/NotContainsUrl";

const readFile = util.promisify(fs.readFile);

export type TeamPreferences = Record<string, unknown>;

@Scopes(() => ({
  withDomains: {
    include: [{ model: TeamDomain }],
  },
  withAuthenticationProviders: {
    include: [
      {
        model: AuthenticationProvider,
        as: "authenticationProviders",
      },
    ],
  },
}))
@Table({ tableName: "teams", modelName: "team" })
@Fix
class Team extends ParanoidModel {
  @NotContainsUrl
  @Length({ min: 2, max: 255, msg: "name must be between 2 to 255 characters" })
  @Column
  name: string;

  @IsLowercase
  @Unique
  @Length({
    min: 2,
    max: 32,
    msg: "subdomain must be between 2 and 32 characters",
  })
  @Is({
    args: [/^[a-z\d-]+$/, "i"],
    msg: "Must be only alphanumeric and dashes",
  })
  @NotIn({
    args: [RESERVED_SUBDOMAINS],
    msg: "You chose a restricted word, please try another.",
  })
  @Column
  subdomain: string | null;

  @Unique
  @Length({ max: 255, msg: "domain must be 255 characters or less" })
  @IsFQDN
  @Column
  domain: string | null;

  @IsUUID(4)
  @Column(DataType.UUID)
  defaultCollectionId: string | null;

  @AllowNull
  @IsUrl
  @Length({ max: 4096, msg: "avatarUrl must be 4096 characters or less" })
  @Column
  avatarUrl: string | null;

  @Default(true)
  @Column
  sharing: boolean;

  @Default(false)
  @Column
  inviteRequired: boolean;

  @Default(true)
  @Column(DataType.JSONB)
  signupQueryParams: { [key: string]: string } | null;

  @Default(true)
  @Column
  guestSignin: boolean;

  @Default(true)
  @Column
  documentEmbeds: boolean;

  @Default(true)
  @Column
  memberCollectionCreate: boolean;

  @Default(true)
  @Column
  collaborativeEditing: boolean;

  @Default("member")
  @IsIn([["viewer", "member"]])
  @Column
  defaultUserRole: string;

  @AllowNull
  @Column(DataType.JSONB)
  preferences: TeamPreferences | null;

  // getters

  /**
   * Returns whether the team has email login enabled. For self-hosted installs
   * this also considers whether SMTP connection details have been configured.
   *
   * @return {boolean} Whether to show email login options
   */
  get emailSigninEnabled(): boolean {
    return (
      this.guestSignin && (!!env.SMTP_HOST || env.ENVIRONMENT === "development")
    );
  }

  get url() {
    // custom domain
    if (this.domain) {
      return `https://${this.domain}`;
    }

    if (!this.subdomain || !env.SUBDOMAINS_ENABLED) {
      return env.URL;
    }

    const url = new URL(env.URL);
    url.host = `${this.subdomain}.${getBaseDomain()}`;
    return url.href.replace(/\/$/, "");
  }

  get logoUrl() {
    return (
      this.avatarUrl ||
      generateAvatarUrl({
        id: this.id,
        name: this.name,
      })
    );
  }

  /**
   * Preferences that decide behavior for the team.
   *
   * @param preference The team preference to set
   * @param value Sets the preference value
   * @returns The current team preferences
   */
  public setPreference = (preference: TeamPreference, value: boolean) => {
    if (!this.preferences) {
      this.preferences = {};
    }
    this.preferences[preference] = value;
    this.changed("preferences", true);

    return this.preferences;
  };

  /**
   * Returns the passed preference value
   *
   * @param preference The user preference to retrieve
   * @returns The preference value if set, else undefined
   */
  public getPreference = (preference: TeamPreference) => {
    return !!this.preferences && this.preferences[preference]
      ? this.preferences[preference]
      : undefined;
  };

  provisionFirstCollection = async (userId: string) => {
    await this.sequelize!.transaction(async (transaction) => {
      const collection = await Collection.create(
        {
          name: "Welcome",
          description:
            "This collection is a quick guide to what Outline is all about. Feel free to delete this collection once your team is up to speed with the basics!",
          teamId: this.id,
          createdById: userId,
          sort: Collection.DEFAULT_SORT,
          permission: CollectionPermission.ReadWrite,
        },
        {
          transaction,
        }
      );

      // For the first collection we go ahead and create some intitial documents to get
      // the team started. You can edit these in /server/onboarding/x.md
      const onboardingDocs = [
        "Integrations & API",
        "Our Editor",
        "Getting Started",
        "What is Outline",
      ];

      for (const title of onboardingDocs) {
        const text = await readFile(
          path.join(process.cwd(), "server", "onboarding", `${title}.md`),
          "utf8"
        );
        const document = await Document.create(
          {
            version: 2,
            isWelcome: true,
            parentDocumentId: null,
            collectionId: collection.id,
            teamId: collection.teamId,
            userId: collection.createdById,
            lastModifiedById: collection.createdById,
            createdById: collection.createdById,
            title,
            text,
          },
          { transaction }
        );
        await document.publish(collection.createdById, { transaction });
      }
    });
  };

  public collectionIds = async function (this: Team, paranoid = true) {
    const models = await Collection.findAll({
      attributes: ["id"],
      where: {
        teamId: this.id,
        permission: {
          [Op.ne]: null,
        },
      },
      paranoid,
    });
    return models.map((c) => c.id);
  };

  /**
   * Find whether the passed domain can be used to sign-in to this team. Note
   * that this method always returns true if no domain restrictions are set.
   *
   * @param domain The domain to check
   * @returns True if the domain is allowed to sign-in to this team
   */
  public isDomainAllowed = async function (
    this: Team,
    domain: string
  ): Promise<boolean> {
    const allowedDomains = (await this.$get("allowedDomains")) || [];

    return (
      allowedDomains.length === 0 ||
      allowedDomains.map((d: TeamDomain) => d.name).includes(domain)
    );
  };

  // associations

  @HasMany(() => Collection)
  collections: Collection[];

  @HasMany(() => Document)
  documents: Document[];

  @HasMany(() => User)
  users: User[];

  @HasMany(() => AuthenticationProvider)
  authenticationProviders: AuthenticationProvider[];

  @HasMany(() => TeamDomain)
  allowedDomains: TeamDomain[];

  // hooks

  @AfterUpdate
  static deletePreviousAvatar = async (model: Team) => {
    if (
      model.previous("avatarUrl") &&
      model.previous("avatarUrl") !== model.avatarUrl
    ) {
      const attachmentIds = parseAttachmentIds(
        model.previous("avatarUrl"),
        true
      );
      if (!attachmentIds.length) {
        return;
      }

      const attachment = await Attachment.findOne({
        where: {
          id: attachmentIds[0],
          teamId: model.id,
        },
      });

      if (attachment) {
        await DeleteAttachmentTask.schedule({
          attachmentId: attachment.id,
        });
      }
    }
  };
}

export default Team;
